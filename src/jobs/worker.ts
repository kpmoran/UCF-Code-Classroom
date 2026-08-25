import 'server-only'

import { provisionIndividualRepo } from './provisionIndividualRepo'
import { provisionTeamRepo } from './provisionTeamRepo'
import { createProjectBoard } from './createProjectBoard'
import { enforceDeadlines } from './enforceDeadlines'
import { ensureFeedbackPr, sweepFeedbackPrs } from './ensureFeedbackPr'
import { ingestAutogradeRun } from './ingestAutogradeRun'
import { revokeStudentAccess } from './revokeStudentAccess'
import { getBoss, QUEUES } from './queue'

/**
 * Register job handlers.
 *
 * Concurrency is deliberately low. The bottleneck is GitHub's content-creation
 * budget, not local CPU or database throughput, so extra workers would only
 * contend for the same tokens and add rate-limit churn. Two gives a little
 * overlap while one job waits on GitHub's asynchronous template copy.
 */

let started = false

export async function startWorker(): Promise<void> {
  if (started) return
  started = true

  const boss = await getBoss()

  await boss.work<{ assignmentRepoId: string }>(
    QUEUES.provisionIndividualRepo,
    { batchSize: 1, localConcurrency: 2 },
    // v10+ hands the handler an array even when batchSize is 1.
    async (jobs) => {
      for (const job of jobs) {
        await provisionIndividualRepo(job.data)
      }
    },
  )

  await boss.work<{ assignmentRepoId: string }>(
    QUEUES.provisionTeamRepo,
    // Concurrency of 1: team provisioning creates a GitHub team and several
    // memberships, and two jobs for the same team racing would both try to
    // create it. The singleton key prevents duplicate jobs, but serialising is
    // the cheap belt-and-braces guarantee.
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await provisionTeamRepo(job.data)
      }
    },
  )

  await boss.work<{
    classroomId: string
    userId: string
    assignmentId?: string
    repoAction: 'KEEP' | 'ARCHIVE' | 'DELETE'
  }>(
    QUEUES.revokeStudentAccess,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await revokeStudentAccess(job.data)
      }
    },
  )

  await boss.work<{ githubRepoId: string; workflowRunId: string }>(
    QUEUES.ingestAutogradeRun,
    // A little parallelism: each job downloads an artifact, which is I/O bound and
    // costs no content-creation budget.
    { batchSize: 1, localConcurrency: 3 },
    async (jobs) => {
      for (const job of jobs) {
        await ingestAutogradeRun(job.data)
      }
    },
  )

  await boss.work(
    QUEUES.enforceDeadlines,
    { batchSize: 1, localConcurrency: 1 },
    async () => {
      await enforceDeadlines()
    },
  )

  /**
   * Run the deadline sweep every five minutes.
   *
   * `schedule` is keyed by queue name, so calling it on every start updates the
   * existing schedule rather than accumulating duplicates. Five minutes is a
   * deliberate compromise: a student sees write access withdrawn within a few
   * minutes of the deadline, and an extension restores it just as promptly,
   * without the sweep running so often that it becomes noise in the logs.
   */
  await boss.schedule(QUEUES.enforceDeadlines, '*/5 * * * *', {}, { singletonKey: 'deadline-sweep' })

  await boss.work<{ assignmentRepoId: string }>(
    QUEUES.ensureFeedbackPr,
    { batchSize: 1, localConcurrency: 2 },
    async (jobs) => {
      for (const job of jobs) {
        await ensureFeedbackPr(job.data)
      }
    },
  )

  await boss.work<{ assignmentRepoId: string }>(
    QUEUES.createProjectBoard,
    { batchSize: 1, localConcurrency: 2 },
    async (jobs) => {
      for (const job of jobs) {
        await createProjectBoard(job.data)
      }
    },
  )

  await boss.work(
    QUEUES.sweepFeedbackPrs,
    { batchSize: 1, localConcurrency: 1 },
    async () => {
      await sweepFeedbackPrs()
    },
  )

  /**
   * Feedback pull requests cannot be opened until a student pushes, and the push
   * webhook may not be configured — so this sweep is what makes the feature work
   * at all in that case, and what recovers deliveries missed during downtime.
   * Every ten minutes: prompt enough to be useful, rare enough to stay quiet.
   */
  await boss.schedule(
    QUEUES.sweepFeedbackPrs,
    '*/10 * * * *',
    {},
    { singletonKey: 'feedback-pr-sweep' },
  )

  console.log(
    '[jobs] worker started; deadline sweep every 5 minutes, feedback PR sweep every 10',
  )
}
