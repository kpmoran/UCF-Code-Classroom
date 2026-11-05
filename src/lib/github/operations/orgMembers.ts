import 'server-only'

import { githubRead } from '../app'
import { GitHubDomainError } from '../errors'

import { teamMutate } from './teams'

/**
 * Organization membership for students.
 *
 * Students are invited to the organization through a classroom team (see
 * lib/students/orgAccess.ts), so the invitation itself is `addTeamMembership`. What
 * lives here is everything around it: reading whether someone is already a member,
 * checking the org is configured so that membership is safe to hand out, replacing an
 * invitation that went unaccepted, and taking membership away at the end of a term.
 *
 * Writes go through `teamMutate`, for the same App-token-first, owner-token-fallback
 * reason as team operations: every one of these is an `Organization members` write.
 */

export type OrgMembership = {
  state: 'active' | 'pending'
  /** GitHub calls an owner `admin` on this endpoint. */
  role: 'admin' | 'member' | string
}

/** Someone's membership of the organization, or null when they have none. */
export async function getOrgMembership(
  installationId: bigint,
  org: string,
  username: string,
): Promise<OrgMembership | null> {
  try {
    const data = await githubRead(
      `get org membership for user ${username} in org ${org}`,
      installationId,
      (octokit) => octokit.rest.orgs.getMembershipForUser({ org, username }).then((r) => r.data),
    )
    return { state: data.state === 'pending' ? 'pending' : 'active', role: data.role }
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw error
  }
}

export type OrgAccessSettings = {
  /** 'none', 'read', 'write' or 'admin'; null when GitHub did not say. */
  baseRepositoryPermission: string | null
  /** Whether plain members may create repositories; null when GitHub did not say. */
  membersCanCreateRepositories: boolean | null
}

/**
 * The organization settings that decide whether making students members is safe.
 *
 * Both fields are returned only to a caller with organization administration read
 * access, which the App requests; they come back null rather than failing when it is
 * missing, so the caller can say "could not check" instead of guessing.
 */
export async function getOrgAccessSettings(
  installationId: bigint,
  org: string,
): Promise<OrgAccessSettings> {
  const data = await githubRead(`get org ${org}`, installationId, (octokit) =>
    octokit.rest.orgs.get({ org }).then((r) => r.data),
  )
  return {
    baseRepositoryPermission: data.default_repository_permission ?? null,
    membersCanCreateRepositories: data.members_can_create_repositories ?? null,
  }
}

/** The id of someone's outstanding invitation to the organization, or null. */
export async function findPendingOrgInvitation(
  installationId: bigint,
  org: string,
  username: string,
): Promise<bigint | null> {
  const invitations = await githubRead(
    `list pending invitations for org ${org}`,
    installationId,
    (octokit) =>
      octokit.paginate(octokit.rest.orgs.listPendingInvitations, { org, per_page: 100 }),
  )
  const lower = username.toLowerCase()
  const match = invitations.find((i) => i.login?.toLowerCase() === lower)
  return match ? BigInt(match.id) : null
}

/** Cancel an invitation to the organization. Already gone counts as done. */
export async function cancelOrgInvitation(
  classroomId: string,
  installationId: bigint,
  org: string,
  invitationId: bigint,
): Promise<void> {
  try {
    await teamMutate(`cancel invitation in org ${org}`, classroomId, installationId, (octokit) =>
      octokit.rest.orgs.cancelInvitation({ org, invitation_id: Number(invitationId) }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}

/**
 * Turn a member into an outside collaborator.
 *
 * They leave the organization but keep the direct access they hold on individual
 * repositories — which, for a student, is exactly their own repositories. The gentle
 * end-of-term option: nobody loses their work.
 */
export async function convertToOutsideCollaborator(
  classroomId: string,
  installationId: bigint,
  org: string,
  username: string,
): Promise<void> {
  try {
    await teamMutate(
      `convert user ${username} to outside collaborator in org ${org}`,
      classroomId,
      installationId,
      (octokit) => octokit.rest.orgs.convertMemberToOutsideCollaborator({ org, username }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}

/**
 * Remove someone from the organization entirely, including any repository access
 * they hold in it. Also cancels a pending invitation. Already gone counts as done.
 */
export async function removeOrgMember(
  classroomId: string,
  installationId: bigint,
  org: string,
  username: string,
): Promise<void> {
  try {
    await teamMutate(
      `remove user ${username} from org ${org}`,
      classroomId,
      installationId,
      (octokit) => octokit.rest.orgs.removeMembershipForUser({ org, username }),
    )
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}
