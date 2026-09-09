import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { grantStaffAccessToRepo } from '@/lib/staff/team'

import type { GrantStaffRepoAccessJob } from './queue'

/**
 * Give the classroom's staff team access to one assignment repository.
 *
 * A job rather than part of provisioning for the usual reason: it is a GitHub write
 * per repository competing for the same content-creation budget as generating the
 * repositories themselves, so doing it inline would make a whole class accepting at
 * once push provisioning over the limit.
 *
 * One write per repository regardless of how many staff there are — the membership
 * side is handled once per classroom by `syncStaffTeam`, not here.
 */
export async function grantStaffRepoAccess(job: GrantStaffRepoAccessJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      failureReason: true,
      assignment: {
        select: {
          classroomId: true,
          classroom: {
            select: { githubOrgLogin: true, installationId: true, staffTeamSlug: true },
          },
        },
      },
    },
  })

  if (!repo || !repo.fullName) return

  const { classroomId, classroom } = repo.assignment

  // No team yet means nobody has set staff access up for this classroom. Not an
  // error and not something to record on the student's row: the panel that creates
  // the team is where this gets resolved.
  if (!classroom.staffTeamSlug) {
    console.log(`[jobs] staff access skipped for ${repo.fullName}: no staff team for this classroom`)
    return
  }

  try {
    await grantStaffAccessToRepo({
      classroomId,
      installationId: classroom.installationId,
      org: classroom.githubOrgLogin,
      teamSlug: classroom.staffTeamSlug,
      repo: repo.fullName.split('/')[1],
    })
    console.log(`[jobs] staff team ${classroom.staffTeamSlug} granted access to ${repo.fullName}`)

    if (repo.failureReason?.includes('Staff access')) {
      await db.assignmentRepo.update({ where: { id: repo.id }, data: { failureReason: null } })
    }
  } catch (error) {
    // Retryable means the rate limiter said "not now"; rethrowing reschedules with
    // backoff. Swallowing it here is the mistake that left six project boards
    // promising they would "continue automatically" while nothing ran again.
    if (error instanceof GitHubDomainError && error.retryable) throw error

    const message = error instanceof GitHubDomainError ? error.userMessage : (error as Error).message
    const note = `Staff access could not be granted: ${message}`

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        failureReason: repo.failureReason?.includes('Staff access')
          ? note
          : [repo.failureReason, note].filter(Boolean).join(' '),
      },
    })
    console.warn(`[jobs] staff access failed for ${repo.fullName}: ${(error as Error).message}`)
  }
}
