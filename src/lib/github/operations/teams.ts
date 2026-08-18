import 'server-only'

import type { Octokit } from '@octokit/rest'

import { githubMutate, githubRead } from '../app'
import { GitHubDomainError } from '../errors'
import { checkOwnerToken, ownerMutate } from '../ownerToken'
import { slugifyTeamName } from '../repoName'

import type { Permission } from './collaborators'

export { slugifyTeamName }

/**
 * Run a team mutation, preferring the App installation token.
 *
 * Verified against a live organization: the App installation token (with
 * `Organization members: write`) creates teams and manages membership
 * successfully, and a membership call for a nonexistent user returns **404, not
 * 403** — meaning authorization was satisfied and only the account lookup
 * failed. So the App token is the primary path, which means group assignments
 * work without an instructor first connecting an elevated personal token.
 *
 * The instructor owner token is kept strictly as a fallback, because GitHub's
 * documentation states that inviting a user who is not yet an organization
 * member requires an org **owner**, and the 404 above is strong but indirect
 * evidence rather than proof. If GitHub ever refuses the App token with an
 * authorization error, we transparently retry as the instructor.
 *
 * Only authorization failures fall through. A 404 or 422 is a real problem with
 * the request and retrying with another credential would just obscure it.
 */
async function teamMutate<T>(
  context: string,
  classroomId: string,
  installationId: bigint,
  fn: (octokit: Octokit) => Promise<T>,
): Promise<T> {
  try {
    return await githubMutate(context, installationId, fn)
  } catch (error) {
    const isAuthFailure =
      error instanceof GitHubDomainError &&
      (error.kind === 'NotOrgOwner' || error.kind === 'InsufficientPermissions')

    if (!isAuthFailure) throw error

    const owner = await checkOwnerToken(classroomId)
    if (!owner.ok) {
      // Re-throw the original authorization error, but explain the remedy.
      throw new GitHubDomainError({
        kind: 'NotOrgOwner',
        status: error.status,
        message: `${context}: App token refused and no owner token available (${owner.reason})`,
        userMessage:
          'GitHub would not let the app manage teams for this organization, and no ' +
          `organization owner is connected as a fallback. ${owner.reason}`,
        cause: error,
      })
    }

    console.warn(
      `[github] ${context}: App token refused (${error.kind}); retrying as organization owner`,
    )
    return ownerMutate(context, classroomId, installationId, fn)
  }
}

/**
 * GitHub team operations, for group assignments.
 *
 * All mutations go through `teamMutate`, which uses the App installation token
 * first and falls back to the instructor's owner token only if GitHub refuses on
 * authorization grounds. See that function for the evidence behind this ordering.
 */

export type TeamSummary = {
  id: bigint
  slug: string
  name: string
}

/** Look up a team by slug, or null. Uses the App token — reads are permitted. */
export async function getTeam(
  installationId: bigint,
  org: string,
  slug: string,
): Promise<TeamSummary | null> {
  try {
    const data = await githubRead(
      `get team ${slug} in org ${org}`,
      installationId,
      (octokit) => octokit.rest.teams.getByName({ org, team_slug: slug }).then((r) => r.data),
    )
    return { id: BigInt(data.id), slug: data.slug, name: data.name }
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw error
  }
}

/**
 * Recover when a slug-keyed team mutation 404s because the team is already gone.
 *
 * Deleting a team is eventually consistent, and the read path lags the write path.
 * Measured against the live API:
 *
 *     +434ms   GET team -> 200 (id=19030092)   PUT membership -> 200
 *     +1670ms  GET team -> 404                 PUT membership -> 404
 *
 * That window is long enough for `createTeam`'s existence pre-check to adopt a team
 * that has already been deleted and report `created: false`. Provisioning then does
 * a few seconds of other work, by which time the deletion has reached the read
 * path, and every remaining call keyed on that slug 404s permanently.
 *
 * A 404 from these endpoints is ambiguous — missing team, missing user, missing
 * repository — and `toDomainError` has to choose, so it blames the student ("that
 * GitHub username does not exist") or the installation ("the app is no longer
 * installed"). Both are wrong here, and both send an instructor chasing a problem
 * that does not exist.
 *
 * So on a 404, ask whether the team is still there:
 *
 *   * Gone — we adopted a deleted team. Retryable, so the queue reruns the job and
 *     `createTeam` makes a real one. This is the self-healing path.
 *   * Still there — the 404 is about the user or the repository, a real error.
 *     Rethrown immediately, because no amount of waiting conjures a missing account.
 *
 * Handled here rather than by marking every 404 retryable, because pg-boss would
 * rerun the whole provisioning job — recreating teams, regenerating repositories —
 * to get past an error that is usually permanent.
 */
async function withDeletedTeamRecovery<T>(
  installationId: bigint,
  org: string,
  teamSlug: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (!(error instanceof GitHubDomainError) || error.status !== 404) throw error
    if (await getTeam(installationId, org, teamSlug)) throw error

    throw new GitHubDomainError({
      kind: 'Unknown',
      status: 404,
      message: `team ${org}/${teamSlug} no longer exists; it was most likely deleted while this job was running`,
      userMessage:
        'The GitHub team for this group no longer exists — it was most likely deleted while setup was running. This will be retried and the team recreated.',
      retryable: true,
      retryAfterMs: 15_000,
      cause: error,
    })
  }
}

/**
 * Create a team, or return the existing one with that name.
 *
 * Idempotent because a retried group-provisioning job must not create
 * "the-knights-1", "the-knights-2", and so on.
 */
export async function createTeam(
  classroomId: string,
  installationId: bigint,
  org: string,
  name: string,
  description?: string,
): Promise<{ team: TeamSummary; created: boolean }> {
  const slug = slugifyTeamName(name)
  const existing = await getTeam(installationId, org, slug)
  if (existing) return { team: existing, created: false }

  const data = await teamMutate(
    `create team in org ${org}`,
    classroomId,
    installationId,
    (octokit) =>
      octokit.rest.teams
        .create({
          org,
          name,
          description,
          // `closed` so all org members can see the team exists; `secret` teams
          // cannot be nested and are invisible to non-members, which makes
          // troubleshooting a student's missing access much harder.
          privacy: 'closed',
        })
        .then((r) => r.data),
  )

  return { team: { id: BigInt(data.id), slug: data.slug, name: data.name }, created: true }
}

export type MembershipState = 'active' | 'pending'

/**
 * Invite a user to a team.
 *
 * Returns `pending` when GitHub emailed an invitation the student has not yet
 * accepted. A pending member **cannot push to the team's repository**, so the
 * caller must surface this rather than reporting success.
 */
export async function addTeamMembership(
  classroomId: string,
  installationId: bigint,
  org: string,
  teamSlug: string,
  username: string,
): Promise<{ state: MembershipState }> {
  const data = await withDeletedTeamRecovery(installationId, org, teamSlug, () =>
    teamMutate(
      `add team membership for user ${username} in org ${org}`,
      classroomId,
      installationId,
      (octokit) =>
        octokit.rest.teams
          .addOrUpdateMembershipForUserInOrg({
            org,
            team_slug: teamSlug,
            username,
            role: 'member',
          })
          .then((r) => r.data),
    ),
  )

  return { state: data.state === 'pending' ? 'pending' : 'active' }
}

/**
 * Current membership state, or null if the user is not on the team.
 *
 * Reads use the App token: it has `Organization members` access, and requiring
 * the instructor's personal token just to *display* whether a student has
 * accepted their invitation would make the UI depend on a credential that is
 * only needed for writes.
 */
export async function getTeamMembership(
  installationId: bigint,
  org: string,
  teamSlug: string,
  username: string,
): Promise<MembershipState | null> {
  try {
    const data = await githubRead(
      `get team membership for user ${username} in org ${org}`,
      installationId,
      (octokit) =>
        octokit.rest.teams
          .getMembershipForUserInOrg({ org, team_slug: teamSlug, username })
          .then((r) => r.data),
    )
    return data.state === 'pending' ? 'pending' : 'active'
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw error
  }
}

export async function removeTeamMembership(
  classroomId: string,
  installationId: bigint,
  org: string,
  teamSlug: string,
  username: string,
): Promise<void> {
  try {
    await teamMutate(
      `remove team membership for user ${username} in org ${org}`,
      classroomId,
      installationId,
      (octokit) =>
        octokit.rest.teams.removeMembershipForUserInOrg({ org, team_slug: teamSlug, username }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}

/** Grant a team access to a repository. Idempotent — GitHub upserts. */
export async function addTeamRepoAccess(
  classroomId: string,
  installationId: bigint,
  org: string,
  teamSlug: string,
  repoOwner: string,
  repo: string,
  permission: Permission,
): Promise<void> {
  await withDeletedTeamRecovery(installationId, org, teamSlug, () =>
    teamMutate(
      `add repo access for team ${teamSlug} in org ${org}`,
      classroomId,
      installationId,
      (octokit) =>
        octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: teamSlug,
          owner: repoOwner,
          repo,
          permission,
        }),
    ),
  )
}

export async function deleteTeam(
  classroomId: string,
  installationId: bigint,
  org: string,
  teamSlug: string,
): Promise<void> {
  try {
    await teamMutate(
      `delete team ${teamSlug} in org ${org}`,
      classroomId,
      installationId,
      (octokit) => octokit.rest.teams.deleteInOrg({ org, team_slug: teamSlug }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}
