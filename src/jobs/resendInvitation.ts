import 'server-only'

import { RepoStatus } from '@prisma/client'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  addCollaborator,
  cancelInvitation,
  isCollaborator,
  toGitHubPermission,
} from '@/lib/github/operations/collaborators'

import type { ResendInvitationJob } from './queue'

const RESEND_FAILED_PREFIX = 'Could not resend the GitHub invitation:'

/**
 * Replace a student's unaccepted repository invitation with a fresh one.
 *
 * GitHub expires a repository invitation after seven days, and re-adding a user
 * whose invitation is still pending neither re-sends the email nor extends it. So
 * the old invitation is cancelled first and a new one issued, which GitHub emails
 * afresh with a new expiry.
 *
 * Idempotent across retries: cancelling an invitation that is already gone is a
 * no-op, so a job refused by the rate budget between the two writes simply
 * cancels nothing and invites on its next attempt.
 */
export async function resendInvitation(job: ResendInvitationJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      status: true,
      fullName: true,
      invitationId: true,
      lockedAt: true,
      failureReason: true,
      user: { select: { githubLogin: true } },
      assignment: {
        select: {
          studentPermission: true,
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  if (!repo || repo.status !== RepoStatus.READY || repo.invitationId === null) return
  const login = repo.user?.githubLogin
  if (!login || !repo.fullName) return

  const { githubOrgLogin: org, installationId } = repo.assignment.classroom
  const name = repo.fullName.split('/')[1]

  try {
    // Accepted since the page last looked: nothing to resend, only a stale row.
    if (await isCollaborator(installationId, org, name, login)) {
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { invitationId: null },
      })
      return
    }

    await cancelInvitation(installationId, org, name, repo.invitationId)

    /*
     * A repository already locked at its deadline is re-invited read-only. Inviting
     * at the assignment's usual permission would quietly unlock it, since the
     * deadline sweep only re-locks repositories it has not already locked. Granting
     * an extension is what restores write access, and it works on the new invitation
     * the same way it would have on the old one.
     */
    const permission = repo.lockedAt
      ? 'pull'
      : toGitHubPermission(repo.assignment.studentPermission)

    const access = await addCollaborator(installationId, org, name, login, permission)

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        invitationId: access.state === 'invited' ? access.invitationId : null,
        failureReason: clearResendFailure(repo.failureReason),
      },
    })
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error

    const reason = error instanceof GitHubDomainError ? error.userMessage : String(error)
    console.warn(`[jobs] could not resend invitation for ${repo.fullName}: ${reason}`)

    /*
     * The repository still works, so the row stays READY; the reason goes on it as a
     * warning where the instructor will see it. Appended rather than overwriting, so
     * an existing autograding warning is not lost.
     */
    const kept = clearResendFailure(repo.failureReason)
    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        failureReason: [kept, `${RESEND_FAILED_PREFIX} ${reason}`].filter(Boolean).join(' '),
      },
    })
  }
}

/** Drop a previous resend failure from a row's warning, keeping anything else. */
function clearResendFailure(reason: string | null): string | null {
  if (!reason) return null
  const index = reason.indexOf(RESEND_FAILED_PREFIX)
  if (index === -1) return reason
  const kept = reason.slice(0, index).trim()
  return kept.length > 0 ? kept : null
}
