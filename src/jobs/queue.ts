import 'server-only'

import { PgBoss } from 'pg-boss'

import { env } from '@/lib/env'

/**
 * Job queue.
 *
 * Provisioning is asynchronous by necessity, not by preference: GitHub allows
 * roughly 80 content-creating requests per minute and 500 per hour, so a
 * 200-student assignment cannot be set up inside a web request. Every GitHub
 * mutation therefore runs here, paced by the shared rate budget.
 *
 * pg-boss keeps its state in Postgres (its own `pgboss` schema), which avoids
 * adding Redis for what is a low-volume queue, and means a job survives a server
 * restart mid-provision.
 */

export const QUEUES = {
  provisionIndividualRepo: 'provision-individual-repo',
  provisionTeamRepo: 'provision-team-repo',
  ingestAutogradeRun: 'ingest-autograde-run',
  enforceDeadlines: 'enforce-deadlines',
  revokeStudentAccess: 'revoke-student-access',
  ensureFeedbackPr: 'ensure-feedback-pr',
  sweepFeedbackPrs: 'sweep-feedback-prs',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * Retry policy.
 *
 * A rate-limit refusal is an expected outcome during a bulk provision, not an
 * error, so the limit is high and the backoff capped: the handler checks the
 * budget before calling GitHub, so a refused attempt costs one database
 * round trip and no API quota. Exponential backoff up to two minutes lets a
 * queue of hundreds of jobs pace itself against the budget without hammering.
 */
const RETRY_POLICY = {
  retryLimit: 40,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 120,
  // Generous: repo generation waits for GitHub's async template copy.
  expireInSeconds: 300,
} as const

let bossPromise: Promise<PgBoss> | null = null

/**
 * The started pg-boss instance.
 *
 * Cached as a promise so concurrent callers share one connection pool and one
 * schema migration, rather than racing to start several.
 */
export function getBoss(): Promise<PgBoss> {
  bossPromise ??= start()
  return bossPromise
}

async function start(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Small pool: the worker is I/O bound on GitHub, not on Postgres.
    max: 4,
    schema: 'pgboss',
  })

  boss.on('error', (error) => {
    // pg-boss surfaces background failures here; swallowing them would hide a
    // queue that has quietly stopped working.
    console.error('[jobs] pg-boss error:', error)
  })

  await boss.start()

  // v10+ requires queues to exist before send() or work().
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name)
  }

  return boss
}

export type ProvisionIndividualRepoJob = {
  assignmentRepoId: string
}

export type ProvisionTeamRepoJob = {
  assignmentRepoId: string
}

export type IngestAutogradeRunJob = {
  /** GitHub repository id, so the job works even if the repo was renamed. */
  githubRepoId: string
  workflowRunId: string
}

/**
 * Deadline sweep. Carries no payload: it examines every classroom, which is what
 * makes it self-healing after downtime rather than dependent on a job having been
 * scheduled at the right moment.
 */
export type EnforceDeadlinesJob = Record<string, never>

/**
 * Revoke a student's GitHub access, optionally disposing of their repositories.
 *
 * Runs as a job rather than inline in the request: a student in a large course
 * may hold a dozen repositories, and each one costs two or three content-creating
 * calls, which is enough to be refused by the rate budget partway through. A
 * partially-revoked student is the worst outcome, so the work is resumable.
 */
export type EnsureFeedbackPrJob = {
  assignmentRepoId: string
}

/** Carries no payload; scans for repositories still awaiting a feedback PR. */
export type SweepFeedbackPrsJob = Record<string, never>

export type RevokeStudentAccessJob = {
  classroomId: string
  userId: string
  /** Limit to one assignment, or sweep the whole classroom. */
  assignmentId?: string
  repoAction: 'KEEP' | 'ARCHIVE' | 'DELETE'
}

type JobPayloads = {
  [QUEUES.provisionIndividualRepo]: ProvisionIndividualRepoJob
  [QUEUES.provisionTeamRepo]: ProvisionTeamRepoJob
  [QUEUES.ingestAutogradeRun]: IngestAutogradeRunJob
  [QUEUES.enforceDeadlines]: EnforceDeadlinesJob
  [QUEUES.revokeStudentAccess]: RevokeStudentAccessJob
  [QUEUES.ensureFeedbackPr]: EnsureFeedbackPrJob
  [QUEUES.sweepFeedbackPrs]: SweepFeedbackPrsJob
}

/**
 * Enqueue a job.
 *
 * `singletonKey` deduplicates: enqueuing provisioning twice for the same repo —
 * a double-clicked Accept button, or a bulk provision overlapping a self-serve
 * accept — must not create two repositories.
 */
export async function enqueue<N extends QueueName>(
  name: N,
  data: JobPayloads[N],
  options: { singletonKey?: string; startAfterSeconds?: number } = {},
): Promise<string | null> {
  const boss = await getBoss()

  return boss.send(name, data, {
    ...RETRY_POLICY,
    ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
    ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
  })
}

/** Enqueue many jobs at once, for bulk provisioning. */
export async function enqueueMany<N extends QueueName>(
  name: N,
  jobs: Array<{ data: JobPayloads[N]; singletonKey?: string }>,
): Promise<number> {
  if (jobs.length === 0) return 0
  const boss = await getBoss()

  await boss.insert(
    name,
    jobs.map((job) => ({
      name,
      data: job.data,
      singletonKey: job.singletonKey,
      ...RETRY_POLICY,
    })),
  )

  return jobs.length
}

/** Queue depth, for the provisioning status UI. */
export async function getQueueDepth(name: QueueName): Promise<{
  ready: number
  active: number
  failed: number
}> {
  const boss = await getBoss()
  const queue = await boss.getQueue(name)

  return {
    // readyCount, not queuedCount: the latter includes future-dated retries, so
    // it would overstate the backlog while jobs are backing off.
    ready: queue?.readyCount ?? 0,
    active: queue?.activeCount ?? 0,
    failed: queue?.failedCount ?? 0,
  }
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return
  const boss = await bossPromise
  bossPromise = null
  await boss.stop({ graceful: true })
}
