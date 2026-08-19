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

/**
 * The App's own public page on GitHub, for "install it somewhere else" links.
 *
 * Read from the API rather than configured, because the slug differs per deployment —
 * this repository is run against more than one App registration — and a hardcoded URL
 * would silently point colleagues at somebody else's App.
 */
export async function getAppPublicUrl(): Promise<string | null> {
  try {
    // Typed as nullable because the endpoint is shared with other auth modes.
    const { data } = await getAppOctokit().rest.apps.getAuthenticated()
    if (!data) return null
    if (data.html_url) return data.html_url
    return data.slug ? `https://github.com/apps/${data.slug}` : null
  } catch {
    // Cosmetic. A missing link is worth far less than a failed page render.
    return null
  }
}

/**
 * Does this membership check mean the user belongs to the organization?
 *
 * Extracted and pure so the decision itself is unit tested. The end-to-end suite can
 * show the picker offering nothing, but it cannot isolate this rule from Next.js's own
 * request handling — and this rule is the whole gate.
 *
 * `role: null` is the 404 case: not a member at all, which is the only answer that
 * excludes. An Owner belongs, a plain member belongs, and someone with a *pending*
 * invitation belongs too — the same reason the Owner check warns rather than blocks, so
 * that an instructor mid-promotion is not stranded.
 */
export function belongsToOrg(check: OrgOwnershipCheck): boolean {
  return check.isOwner || check.role !== null
}

export type UserInstallations = {
  /** Organizations the user actually belongs to. */
  belongs: InstallationSummary[]
  /** Installed, but the user is not a member — deliberately not offered. */
  foreign: number
  /** Membership could not be confirmed; excluded rather than assumed. */
  unverifiable: number
}

/**
 * Installations the signed-in user may build a classroom in.
 *
 * `listAppInstallations` returns every installation of the App, App-wide. That was
 * harmless while one person used this, and became a multi-tenancy hole the moment a
 * second faculty member existed: the picker offered them every colleague's
 * organization, the ownership check downstream only *warns*, and assignments in such a
 * classroom would generate repositories in somebody else's org using an installation
 * token that holds `Administration: write` there.
 *
 * So membership is the gate. Being a member is a much weaker claim than being an Owner
 * — that check still runs, and still only warns, because a pending promotion should not
 * strand an instructor — but you cannot be a member of an organization you have nothing
 * to do with, which is exactly the case being excluded.
 *
 * A pending invitation counts as belonging, for the same reason the Owner check warns
 * rather than blocks.
 */
export async function listInstallationsForUser(
  username: string | null,
): Promise<UserInstallations> {
  const all = await listAppInstallations()

  // No linked GitHub login means no way to establish membership in anything.
  if (!username) return { belongs: [], foreign: all.length, unverifiable: 0 }

  const results = await Promise.all(
    all.map(async (installation) => {
      try {
        const check = await checkOrgOwnership(
          installation.installationId,
          installation.orgLogin,
          username,
        )
        // role === null is the 404 case: not a member at all.
        return { installation, belongs: belongsToOrg(check), failed: false }
      } catch {
        // Excluded rather than included. Offering an organization whose membership we
        // could not confirm is the failure this function exists to prevent, and a
        // transient GitHub error is not a reason to reopen it.
        return { installation, belongs: false, failed: true }
      }
    }),
  )

  return {
    belongs: results.filter((r) => r.belongs).map((r) => r.installation),
    foreign: results.filter((r) => !r.belongs && !r.failed).length,
    unverifiable: results.filter((r) => r.failed).length,
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
