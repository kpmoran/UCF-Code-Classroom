import 'server-only'

import { getAppOctokit, githubRead } from '../app'
import { toDomainError } from '../errors'

/**
 * Organization-level reads: which orgs the App is installed on, and whether the
 * signed-in instructor actually owns them.
 */

export type InstallationSummary = {
  installationId: bigint
  orgLogin: string
  orgId: bigint
  avatarUrl: string | null
  /** 'all' or 'selected' — a selected-repos install cannot create new repos. */
  repositorySelection: string
}

/**
 * Every organization this App is installed on.
 *
 * Uses the App JWT rather than an installation token because the point is to
 * discover installations that no classroom references yet.
 */
export async function listAppInstallations(): Promise<InstallationSummary[]> {
  try {
    const octokit = getAppOctokit()
    const installations = await octokit.paginate(octokit.rest.apps.listInstallations, {
      per_page: 100,
    })

    return installations
      .filter((i) => i.account !== null)
      .map((i) => {
        const account = i.account as { login?: string; id: number; avatar_url?: string }
        return {
          installationId: BigInt(i.id),
          orgLogin: account.login ?? '',
          orgId: BigInt(account.id),
          avatarUrl: account.avatar_url ?? null,
          repositorySelection: i.repository_selection,
        }
      })
      .filter((i) => i.orgLogin !== '')
  } catch (error) {
    throw toDomainError(error, 'list app installations for org')
  }
}

export type OrgOwnershipCheck =
  | { isOwner: true; role: 'admin' }
  | { isOwner: false; role: string | null; reason: string }

/**
 * Whether `username` is an *owner* of `org`, as opposed to merely a member.
 *
 * This gate exists because group assignments will otherwise fail late, at the
 * moment a student is invited to a team, with a 403 that reads like a bug. It is
 * far cheaper to refuse to create the classroom, or warn loudly, up front.
 *
 * GitHub's API calls the owner role "admin" on the membership endpoint.
 */
export async function checkOrgOwnership(
  installationId: bigint,
  org: string,
  username: string,
): Promise<OrgOwnershipCheck> {
  try {
    const membership = await githubRead(
      `get org membership for user ${username} in org ${org}`,
      installationId,
      (octokit) =>
        octokit.rest.orgs.getMembershipForUser({ org, username }).then((r) => r.data),
    )

    if (membership.role === 'admin' && membership.state === 'active') {
      return { isOwner: true, role: 'admin' }
    }

    if (membership.state === 'pending') {
      return {
        isOwner: false,
        role: membership.role,
        reason:
          `Your membership in ${org} is still pending — accept the invitation on GitHub, ` +
          'then re-check.',
      }
    }

    return {
      isOwner: false,
      role: membership.role,
      reason:
        `You are a ${membership.role} of ${org}, not an Owner. Group assignments need an ` +
        'Owner to invite students to teams. Ask an existing owner to promote you in the ' +
        'organization’s People settings.',
    }
  } catch (error) {
    const domain = toDomainError(error, `get org membership for user in org ${org}`)
    if (domain.status === 404) {
      return {
        isOwner: false,
        role: null,
        reason: `You do not appear to be a member of ${org} at all.`,
      }
    }
    throw domain
  }
}

/** Org members, used to tell "not invited" from "invited but not accepted". */
export async function listOrgMembers(
  installationId: bigint,
  org: string,
): Promise<Set<string>> {
  const members = await githubRead(`list members of org ${org}`, installationId, (octokit) =>
    octokit.paginate(octokit.rest.orgs.listMembers, { org, per_page: 100 }),
  )
  return new Set(members.map((m) => m.login.toLowerCase()))
}
