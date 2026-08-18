import 'server-only'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { ensureFeedbackPullRequest } from '@/lib/github/operations/pulls'
import { getRepo } from '@/lib/github/operations/repos'

import type { EnsureFeedbackPrJob } from './queue'

/**
 * Open a repository's feedback pull request, if it is due one.
 *
 * Exists because the PR cannot be created at provisioning time: GitHub refuses a
 * pull request with no commits between base and head, and at that moment the student
 * has pushed nothing. So the baseline branch is pinned during provisioning and the
 * PR itself is opened later — the first time the student actually has work to review.
 *
 * Triggered three ways, deliberately overlapping:
 *
 *   - the `push` webhook, for immediacy;
 *   - a periodic sweep, which is what makes this work at all when no webhook is
 *     configured, and what recovers a delivery missed while the app was down;
 *   - an instructor action, for when someone wants it now.
 */
export async function ensureFeedbackPr(job: EnsureFeedbackPrJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      feedbackPrNumber: true,
      assignment: {
        select: {
          feedbackPrEnabled: true,
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  if (!repo?.fullName) return
  if (!repo.assignment.feedbackPrEnabled) return
  if (repo.feedbackPrNumber !== null) return

  const org = repo.assignment.classroom.githubOrgLogin
  const installationId = repo.assignment.classroom.installationId
  const repoName = repo.fullName.split('/')[1]

  const remote = await getRepo(installationId, org, repoName)
  if (!remote) {
    // Deleted since; nothing to do and not an error.
    return
  }

  try {
    const result = await ensureFeedbackPullRequest(
      installationId,
      org,
      repoName,
      remote.defaultBranch,
    )

    if (result.state === 'created' || result.state === 'existing') {
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { feedbackPrNumber: result.number },
      })
    }
    // 'skipped' is left as-is: the student has not pushed yet, and the next
    // trigger will try again. Recording nothing keeps the row eligible.
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error
    console.warn(
      `[jobs] feedback PR for ${repo.fullName} could not be opened: ${
        error instanceof GitHubDomainError ? error.userMessage : String(error)
      }`,
    )
  }
}

/**
 * Find every repository still awaiting a feedback pull request and queue one.
 *
 * Scoped to repositories that have actually been pushed to, so the sweep does not
 * re-attempt the whole class every few minutes for students who have not started —
 * each attempt would otherwise be a wasted pair of GitHub calls.
 */
export async function sweepFeedbackPrs(): Promise<{ queued: number }> {
  const pending = await db.assignmentRepo.findMany({
    where: {
      status: 'READY',
      feedbackPrNumber: null,
      fullName: { not: null },
      // Only once there is something to review.
      lastPushedAt: { not: null },
      assignment: {
        feedbackPrEnabled: true,
        classroom: { archivedAt: null },
      },
    },
    select: { id: true },
    // Bounded so one sweep cannot enqueue thousands of jobs at once; the next
    // pass picks up the remainder.
    take: 200,
  })

  if (pending.length === 0) return { queued: 0 }

  const { enqueueMany, QUEUES } = await import('./queue')
  await enqueueMany(
    QUEUES.ensureFeedbackPr,
    pending.map((repo) => ({
      data: { assignmentRepoId: repo.id },
      singletonKey: `feedback-pr:${repo.id}`,
    })),
  )

  console.log(`[jobs] feedback PR sweep queued ${pending.length} repositor${pending.length === 1 ? 'y' : 'ies'}`)
  return { queued: pending.length }
}
