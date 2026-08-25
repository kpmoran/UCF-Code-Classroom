import 'server-only'

import { db } from '@/lib/db'
import { isCollaborator } from '@/lib/github/operations/collaborators'

/**
 * Find out whether outstanding repository invitations have been accepted.
 *
 * The app records an invitation id when it invites a student and, until now, nothing
 * ever unrecorded it: accepting happens entirely on GitHub, and the App subscribes to
 * no event that would say so. The row therefore said "invitation pending" forever,
 * which the student's page rendered as "Accept your GitHub invitation" — to a student
 * who already had.
 *
 * Asks whether the student is a collaborator rather than whether the invitation is
 * still listed. The two differ in the case that matters: a declined or expired
 * invitation also disappears from the pending list, and treating that as acceptance
 * would replace a wrong "please accept" with a wrong "all good".
 *
 * Reads only, so it does not touch the content-creating rate budget.
 */
export async function reconcileInvitations(
  assignmentId: string,
  /**
   * Narrow to one repository. A student opening their own page should ask about
   * their own invitation, not run a check for the whole class.
   */
  options: { assignmentRepoId?: string } = {},
): Promise<{ checked: number; accepted: number }> {
  const rows = await db.assignmentRepo.findMany({
    where: {
      assignmentId,
      invitationId: { not: null },
      fullName: { not: null },
      ...(options.assignmentRepoId ? { id: options.assignmentRepoId } : {}),
    },
    select: {
      id: true,
      fullName: true,
      user: { select: { githubLogin: true } },
      assignment: {
        select: { classroom: { select: { githubOrgLogin: true, installationId: true } } },
      },
    },
  })

  let accepted = 0

  // Small batches: a large class is a few hundred reads, and firing them all at once
  // is how you turn a tidy check into a burst GitHub throttles.
  const BATCH = 10
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (row) => {
        const login = row.user?.githubLogin
        if (!login || !row.fullName) return null
        const { githubOrgLogin: org, installationId } = row.assignment.classroom
        try {
          const has = await isCollaborator(installationId, org, row.fullName.split('/')[1], login)
          return has ? row.id : null
        } catch {
          // One unreachable repository must not abandon the rest of the class.
          return null
        }
      }),
    )

    const done = results.filter((id): id is string => id !== null)
    if (done.length > 0) {
      await db.assignmentRepo.updateMany({
        where: { id: { in: done } },
        data: { invitationId: null },
      })
      accepted += done.length
    }
  }

  return { checked: rows.length, accepted }
}
