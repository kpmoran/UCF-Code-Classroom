import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getInstallationOctokit } from './app'
import { GitHubDomainError } from './errors'
import { listAppInstallations } from './operations/orgs'
import { addTeamMembership, createTeam, getTeam } from './operations/teams'
import { slugifyTeamName } from './repoName'

/**
 * The decisive question for group assignments: **what can the App installation
 * token do with teams, and where exactly does it stop?**
 *
 * GitHub's docs say `PUT /orgs/{org}/teams/{slug}/memberships/{username}`
 * requires `Organization members: write` (which the App has), but *also* say that
 * inviting a user who is not yet an organization member requires the caller to be
 * an organization **owner**. Those two statements are in tension for an App
 * installation token, which has permissions but is not a user at all.
 *
 * If the App token suffices, the stored instructor owner-token mechanism can be
 * deleted outright — a meaningful simplification and one less credential to
 * expire mid-semester. So this is tested directly rather than assumed.
 *
 * Deliberately sends no invitation to any real person: membership is exercised
 * with the instructor (already an owner) and with a nonexistent username, whose
 * status code reveals whether authorization was reached before user lookup.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const INSTRUCTOR = process.env.VERIFY_USER ?? 'kpmoran'
const TEAM_NAME = 'Verify Team Alpha'
const TEAM_SLUG = slugifyTeamName(TEAM_NAME)
const REPO = 'verify-team-repo'

let installationId: bigint

beforeAll(async () => {
  const installations = await listAppInstallations()
  const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
  if (!match) throw new Error(`App is not installed on ${ORG}`)
  installationId = match.installationId

  const octokit = getInstallationOctokit(installationId)
  try {
    await octokit.rest.teams.deleteInOrg({ org: ORG, team_slug: TEAM_SLUG })
  } catch {
    // Not present; fine.
  }
  try {
    await octokit.rest.repos.delete({ owner: ORG, repo: REPO })
  } catch {
    // Not present; fine.
  }
}, 120_000)

afterAll(async () => {
  if (!installationId) return
  const octokit = getInstallationOctokit(installationId)
  try {
    await octokit.rest.teams.deleteInOrg({ org: ORG, team_slug: TEAM_SLUG })
  } catch {
    /* already gone */
  }
  try {
    await octokit.rest.repos.delete({ owner: ORG, repo: REPO })
  } catch {
    /* already gone */
  }
}, 120_000)

describe('team management with the App installation token', () => {
  it('creates a team', async () => {
    const octokit = getInstallationOctokit(installationId)
    const { data } = await octokit.rest.teams.create({
      org: ORG,
      name: TEAM_NAME,
      description: 'UCF Code Classroom verification team',
      privacy: 'closed',
    })

    console.log(`\n  Team created: ${data.slug} (id ${data.id}) — App token CAN create teams`)
    expect(data.slug).toBe(TEAM_SLUG)
  })

  it('adds an existing org member to the team', async () => {
    const octokit = getInstallationOctokit(installationId)
    const { data } = await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
      org: ORG,
      team_slug: TEAM_SLUG,
      username: INSTRUCTOR,
      role: 'member',
    })

    console.log(
      `\n  Membership for existing member ${INSTRUCTOR}: state=${data.state} role=${data.role}`,
    )
    expect(['active', 'pending']).toContain(data.state)
  })

  it('reveals whether authorization precedes user lookup for a non-member', async () => {
    // The signal: a 404 means we passed the authorization gate and only the user
    // was missing — evidence the App token is permitted to invite non-members.
    // A 403 means authorization itself was refused, so the owner token is
    // genuinely required.
    const octokit = getInstallationOctokit(installationId)
    let status: number | undefined
    let message: string | undefined

    try {
      await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
        org: ORG,
        team_slug: TEAM_SLUG,
        username: 'this-user-does-not-exist-9z8y7x',
        role: 'member',
      })
    } catch (error) {
      const e = error as { status?: number; response?: { data?: { message?: string } } }
      status = e.status
      message = e.response?.data?.message
    }

    console.log(`\n  Non-member invite probe: status=${status} message=${message}`)
    console.log(
      status === 404
        ? '  => 404: authorization passed, only the account was missing.\n' +
            '     Strong evidence the App token may invite non-members.'
        : status === 403
          ? '  => 403: authorization refused. The instructor owner token IS required.'
          : `  => unexpected status ${status}; treat team invites as unverified.`,
    )

    expect(status, 'expected the call to fail for a nonexistent user').toBeDefined()
  })

  it('grants the team access to a repository', async () => {
    const octokit = getInstallationOctokit(installationId)
    await octokit.rest.repos.createInOrg({
      org: ORG,
      name: REPO,
      private: true,
      auto_init: true,
    })

    await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
      org: ORG,
      team_slug: TEAM_SLUG,
      owner: ORG,
      repo: REPO,
      permission: 'push',
    })

    // This endpoint answers 204 with an empty body unless the repository media
    // type is requested explicitly, which is why a naive read looks like it
    // returned nothing.
    const { data } = await octokit.rest.teams.checkPermissionsForRepoInOrg({
      org: ORG,
      team_slug: TEAM_SLUG,
      owner: ORG,
      repo: REPO,
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    })

    console.log(`\n  Team repo access: ${data.full_name} push=${data.permissions?.push}`)
    expect(data.permissions?.push).toBe(true)
  })
})

describe('a team deleted underneath us', () => {
  // Deleting a team is eventually consistent. For about a second afterwards
  // GET /orgs/{org}/teams/{slug} still answers 200 with the old id, which is long
  // enough for createTeam's existence pre-check to adopt a team that is already
  // gone. Every later call keyed on that slug then 404s permanently, and the raw
  // 404 is reported as "that GitHub username does not exist" — about a student who
  // is perfectly fine.
  //
  // This locks in the recovery: the failure must be retryable and must say the
  // team is missing, so the job runs again and recreates it.
  //
  // The wait below is the point, not a workaround. Inside the stale window the
  // membership write *also* still succeeds, so there is nothing to recover from
  // yet; the damage happens when the pre-check reads stale, work proceeds, and the
  // mutation lands after the deletion has caught up. Waiting reproduces that
  // ordering deterministically instead of racing a one-second window.
  const NAME = 'Verify Deleted Team'
  const SLUG = slugifyTeamName(NAME)

  afterAll(async () => {
    if (!installationId) return
    await getInstallationOctokit(installationId)
      .rest.teams.deleteInOrg({ org: ORG, team_slug: SLUG })
      .catch(() => {})
  }, 60_000)

  it('reports a retryable missing-team error rather than a missing user', async () => {
    const octokit = getInstallationOctokit(installationId)
    await octokit.rest.teams.deleteInOrg({ org: ORG, team_slug: SLUG }).catch(() => {})

    const { team } = await createTeam('', installationId, ORG, NAME)
    await octokit.rest.teams.deleteInOrg({ org: ORG, team_slug: team.slug })

    // Let the deletion reach the read path, so the slug is genuinely dead.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (await getTeam(installationId, ORG, team.slug))) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    const error = await addTeamMembership('', installationId, ORG, team.slug, INSTRUCTOR).then(
      () => null,
      (e: unknown) => e,
    )

    console.log(`\n  Deleted team ${team.slug}: ${(error as Error)?.message}`)

    expect(error).toBeInstanceOf(GitHubDomainError)
    const domain = error as GitHubDomainError
    // Retryable is the whole point: the queue reruns the job and recreates the team.
    expect(domain.retryable).toBe(true)
    expect(domain.message).toContain('no longer exists')
    // And it must not accuse the student of not existing.
    expect(domain.userMessage).not.toMatch(/username does not exist/i)
  }, 120_000)
})
