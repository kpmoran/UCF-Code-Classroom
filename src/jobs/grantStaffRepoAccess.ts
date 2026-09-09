import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  grantStaffAccessToRepo,
  revokeStaffAccessFromRepo,
  staffTeamMustAvoidRepo,
} from '@/lib/staff/team'

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
      userId: true,
      team: { select: { members: { select: { userId: true } } } },
      assignment: {
        select: {
          classroomId: true,
          classroom: {
            select: {
              githubOrgLogin: true,
              installationId: true,
              staffTeamSlug: true,
              members: {
                where: { role: { in: ['INSTRUCTOR', 'TA'] } },
                select: { userId: true },
              },
            },
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

  const repoName = repo.fullName.split('/')[1]

  /*
   * A repository belonging to someone who is also staff must be kept off the team.
   *
   * The deadline lock lowers that person's direct collaborator permission to `pull`,
   * and GitHub takes the highest permission across every source of grant, so a team
   * grant of `push` overrides it — the app would show the repository as locked while
   * its owner kept pushing. Revoked rather than merely skipped, so re-running repairs
   * a repository that was granted before this case was understood.
   */
  const participantUserIds = [
    repo.userId,
    ...(repo.team?.members.map((m) => m.userId) ?? []),
  ].filter((id): id is string => Boolean(id))

  const mustAvoid = staffTeamMustAvoidRepo({
    participantUserIds,
    staffUserIds: classroom.members.map((m) => m.userId),
  })

  try {
    // Inside the try, not before it: revoking is a GitHub write like any other and
    // can be refused by the rate limiter, and only the catch below knows to rethrow
    // a retryable refusal so pg-boss reschedules instead of dropping the work.
    if (mustAvoid) {
      await revokeStaffAccessFromRepo({
        classroomId,
        installationId: classroom.installationId,
        org: classroom.githubOrgLogin,
        teamSlug: classroom.staffTeamSlug,
        repo: repoName,
      })
      console.log(
        `[jobs] staff team kept off ${repo.fullName}: a participant is staff in this ` +
          'classroom, so a team grant would override their deadline lock',
      )
      return
    }

    await grantStaffAccessToRepo({
      classroomId,
      installationId: classroom.installationId,
      org: classroom.githubOrgLogin,
      teamSlug: classroom.staffTeamSlug,
      repo: repoName,
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
