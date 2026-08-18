import 'server-only'

import { githubMutate, githubRead } from '../app'
import { GitHubDomainError } from '../errors'

/**
 * Whether a GitHub account exists.
 *
 * Needed because `PUT /repos/{owner}/{repo}/collaborators/{username}` answers a
 * nonexistent username with `403 Resource not accessible by integration` — the
 * same response as a genuine permissions problem (verified against a live org;
 * GitHub presumably does this to prevent username enumeration). Mapping that
 * 403 blindly tells an instructor to go check their App installation when the
 * real cause is a typo in a student's username, so the username is checked
 * first. This is an unmetered read.
 */
export async function userExists(
  installationId: bigint,
  username: string,
): Promise<boolean> {
  try {
    await githubRead(`get user ${username}`, installationId, (octokit) =>
      octokit.rest.users.getByUsername({ username }),
    )
    return true
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return false
    throw error
  }
}

/**
 * Collaborator access for individual assignments.
 *
 * Adding a collaborator to a private repo sends an *invitation* the student must
 * accept; until then the repository exists but they cannot see it. That pending
 * state is the most common source of "the app is broken" reports, so it is
 * modelled explicitly rather than treated as success.
 */

export type Permission = 'pull' | 'push' | 'maintain' | 'admin'

/** Map the schema's StudentPermission enum onto GitHub's vocabulary. */
export function toGitHubPermission(
  permission: 'PULL' | 'PUSH' | 'MAINTAIN' | 'ADMIN',
): Permission {
  switch (permission) {
    case 'PULL':
      return 'pull'
    case 'PUSH':
      return 'push'
    case 'MAINTAIN':
      return 'maintain'
    case 'ADMIN':
      return 'admin'
  }
}

export type AddCollaboratorResult =
  | { state: 'invited'; invitationId: bigint }
  | { state: 'already-collaborator' }

/**
 * Grant a user access to a repository.
 *
 * Idempotent: when the user is already a collaborator at the requested level,
 * GitHub returns 204 with no invitation body, which we report distinctly so the
 * UI does not claim an invitation is pending forever.
 */
export async function addCollaborator(
  installationId: bigint,
  owner: string,
  repo: string,
  username: string,
  permission: Permission,
): Promise<AddCollaboratorResult> {
  // See userExists: GitHub's 403 for an unknown username is indistinguishable
  // from a real permissions failure, so rule out the typo case up front.
  if (!(await userExists(installationId, username))) {
    throw new GitHubDomainError({
      kind: 'UserNotFound',
      status: 404,
      message: `add collaborator: GitHub user ${username} does not exist`,
      userMessage:
        `There is no GitHub account named “${username}”. Check the spelling — the student ` +
        'may have mistyped it, or renamed or deleted their account.',
    })
  }

  const response = await githubMutate(
    `add collaborator user ${username} to repo ${owner}/${repo}`,
    installationId,
    (octokit) => octokit.rest.repos.addCollaborator({ owner, repo, username, permission }),
  )

  // 201 + body => a new invitation. 204 + empty => already had access.
  const data = response.data as { id?: number } | null
  if (data && typeof data.id === 'number') {
    return { state: 'invited', invitationId: BigInt(data.id) }
  }
  return { state: 'already-collaborator' }
}

/** Whether a user currently has accepted access (not merely an invitation). */
export async function isCollaborator(
  installationId: bigint,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  try {
    await githubRead(
      `check collaborator user ${username} on repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.repos.checkCollaborator({ owner, repo, username }),
    )
    return true
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return false
    throw error
  }
}

export type PendingInvitation = {
  invitationId: bigint
  inviteeLogin: string | null
  createdAt: string
  htmlUrl: string
}

/**
 * Outstanding invitations on a repository, so the instructor can see who has not
 * accepted and nudge them.
 */
export async function listPendingInvitations(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<PendingInvitation[]> {
  const invitations = await githubRead(
    `list invitations for repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.paginate(octokit.rest.repos.listInvitations, { owner, repo, per_page: 100 }),
  )

  return invitations.map((i) => ({
    invitationId: BigInt(i.id),
    inviteeLogin: i.invitee?.login ?? null,
    createdAt: i.created_at,
    htmlUrl: i.html_url,
  }))
}

/**
 * Change a collaborator's permission — used to lock repositories at a deadline
 * (down to `pull`) and to restore access when an extension is granted.
 */
export async function setCollaboratorPermission(
  installationId: bigint,
  owner: string,
  repo: string,
  username: string,
  permission: Permission,
): Promise<void> {
  await githubMutate(
    `set permission for collaborator user ${username} on repo ${owner}/${repo}`,
    installationId,
    (octokit) => octokit.rest.repos.addCollaborator({ owner, repo, username, permission }),
  )
}

/** Revoke access. Also cancels a pending invitation. */
export async function removeCollaborator(
  installationId: bigint,
  owner: string,
  repo: string,
  username: string,
): Promise<void> {
  try {
    await githubMutate(
      `remove collaborator user ${username} from repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.repos.removeCollaborator({ owner, repo, username }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}

/** Cancel an invitation that has not been accepted. */
export async function cancelInvitation(
  installationId: bigint,
  owner: string,
  repo: string,
  invitationId: bigint,
): Promise<void> {
  try {
    await githubMutate(
      `delete invitation on repo ${owner}/${repo}`,
      installationId,
      (octokit) =>
        octokit.rest.repos.deleteInvitation({
          owner,
          repo,
          invitation_id: Number(invitationId),
        }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}
