import 'server-only'

import { db } from '@/lib/db'
import { getTeamMembership } from '@/lib/github/operations/teams'

/**
 * Find out whether pending GitHub team invitations have been accepted.
 *
 * The team counterpart of `reconcileInvitations`. A student added to a team who is
 * not yet in the organization gets an invitation from GitHub, and the membership is
 * recorded as `pending`. Accepting happens on GitHub and tells this app nothing, so
 * the row stayed `pending` for good: the instructor's table kept its "invite pending"
 * badge, and the student's page kept asking them to accept.
 *
 * Only `active` clears it. A membership GitHub no longer knows about — the invitation
 * expired, was declined, or the student was removed from the team — stays `pending`,
 * because replacing a stale "please accept" with a wrong "all good" would be worse.
 *
 * Reads only, so it does not touch the content-creating rate budget.
 */
export async function reconcileTeamMemberships(
  assignmentId: string,
  /**
   * Narrow to one student. A student opening their own page should ask about
   * their own invitation, not run a check for the whole class.
   */
  options: { userId?: string } = {},
): Promise<{ checked: number; accepted: number }> {
  const rows = await db.teamMember.findMany({
    where: {
      githubMembershipState: 'pending',
      team: { assignmentId, githubTeamSlug: { not: null } },
      user: { githubLogin: { not: null } },
      ...(options.userId ? { userId: options.userId } : {}),
    },
    select: {
      id: true,
      user: { select: { githubLogin: true } },
      team: {
        select: {
          githubTeamSlug: true,
          assignment: {
            select: { classroom: { select: { githubOrgLogin: true, installationId: true } } },
          },
        },
      },
    },
  })

  let accepted = 0

  // Small batches, for the same reason as the repository check: a class is a few
  // dozen reads, and firing them all at once is how GitHub starts throttling.
  const BATCH = 10
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (row) => {
        const slug = row.team.githubTeamSlug
        const login = row.user.githubLogin
        if (!slug || !login) return null
        const { githubOrgLogin: org, installationId } = row.team.assignment.classroom
        try {
          const state = await getTeamMembership(installationId, org, slug, login)
          return state === 'active' ? row.id : null
        } catch {
          // One unreachable team must not abandon the rest of the class.
          return null
        }
      }),
    )

    const done = results.filter((id): id is string => id !== null)
    if (done.length > 0) {
      await db.teamMember.updateMany({
        where: { id: { in: done } },
        data: { githubMembershipState: 'active' },
      })
      accepted += done.length
    }
  }

  return { checked: rows.length, accepted }
}
