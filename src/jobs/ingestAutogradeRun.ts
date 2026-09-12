import 'server-only'

import { AutogradeStatus, type Prisma } from '@prisma/client'

import { alreadyFullyIngested, selectAutogradeTargets } from '@/lib/autograding/fanout'
import {
  parseResults,
  reconcileWithConfiguredTests,
  ResultsParseError,
} from '@/lib/autograding/parseResults'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { fetchAutogradeResults, listWorkflowRuns } from '@/lib/github/operations/artifacts'

import type { IngestAutogradeRunJob } from './queue'

/**
 * Ingest one autograding run.
 *
 * The app **pulls** results from an Actions artifact rather than having the
 * student's repository push them to a callback URL. That means no per-repository
 * secret to manage or rotate, nothing to change if the app's hostname changes, and
 * — most usefully — grading still works when the app was offline while the
 * workflow ran, because the artifact is still there to fetch afterwards.
 *
 * Idempotent on `(assignmentRepoId, workflowRunId)`, which is unique in the schema:
 * GitHub retries webhook deliveries, and an instructor may re-sync manually at the
 * same time.
 *
 * One GitHub repository can belong to several rows — an individual assignment whose
 * students were each assigned the same existing repository. The artifact is fetched
 * and parsed once and then written to every one of them, because a score recorded
 * against only the first row would leave the other students looking as though they
 * never submitted.
 */
export async function ingestAutogradeRun(job: IngestAutogradeRunJob): Promise<void> {
  const repos = await db.assignmentRepo.findMany({
    where: { githubRepoId: BigInt(job.githubRepoId) },
    select: {
      id: true,
      fullName: true,
      assignment: {
        select: {
          id: true,
          autogradeEnabled: true,
          gradingTests: { select: { id: true, name: true, points: true } },
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  // Results belong to the repository, so every row grading it gets the same score.
  // See selectAutogradeTargets for which rows those are, and why.
  const targets = selectAutogradeTargets(repos)
  const repo = targets[0]

  if (!repo?.fullName) {
    if (repos.length === 0) {
      console.warn(`[jobs] no repository for github id ${job.githubRepoId}; skipping autograde`)
    }
    return
  }

  const org = repo.assignment.classroom.githubOrgLogin
  const installationId = repo.assignment.classroom.installationId
  const repoName = repo.fullName.split('/')[1]
  const workflowRunId = BigInt(job.workflowRunId)

  // Already ingested — a duplicate webhook delivery, or a manual re-sync racing the
  // automatic one.
  const completedCount = await db.autogradeRun.count({
    where: {
      workflowRunId,
      assignmentRepoId: { in: targets.map((t) => t.id) },
      status: AutogradeStatus.COMPLETED,
    },
  })
  if (alreadyFullyIngested({ targetCount: targets.length, completedCount })) return

  let raw: string
  try {
    const artifact = await fetchAutogradeResults(installationId, org, repoName, workflowRunId)

    if (!artifact) {
      // Expected whenever a workflow failed before the upload step, or the
      // repository's template has no autograding at all. Recorded as failed with
      // an explanation rather than retried forever.
      await recordFailure(
        targets.map((t) => t.id),
        workflowRunId,
        'This run produced no autograding results. The workflow may have failed before the ' +
          'tests ran — check the run on GitHub.',
      )
      return
    }
    raw = artifact.raw
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error

    await recordFailure(
      targets.map((t) => t.id),
      workflowRunId,
      error instanceof GitHubDomainError
        ? error.userMessage
        : 'The autograding results could not be downloaded from GitHub.',
    )
    return
  }

  let parsed
  try {
    parsed = parseResults(raw)
  } catch (error) {
    await recordFailure(
      targets.map((t) => t.id),
      workflowRunId,
      error instanceof ResultsParseError
        ? error.message
        : 'The autograding results could not be read.',
      raw,
    )
    return
  }

  // Compare against the assignment's configured tests. A mismatch means the
  // workflow or manifest was modified in the student's repository; it is reported,
  // not silently accepted, and not treated as fatal either.
  const discrepancies = reconcileWithConfiguredTests(
    parsed,
    repo.assignment.gradingTests.map((t) => ({ name: t.name, points: t.points })),
  )

  const testIdByName = new Map(repo.assignment.gradingTests.map((t) => [t.name, t.id]))
  const runMeta = await findRunMetadata(installationId, org, repoName, workflowRunId)

  await db.$transaction(async (tx) => {
    for (const target of targets) {
      // Replace rather than accumulate: re-ingesting the same run must not double
      // its test rows.
      const run = await tx.autogradeRun.upsert({
        where: {
          assignmentRepoId_workflowRunId: { assignmentRepoId: target.id, workflowRunId },
        },
        create: {
          assignmentRepoId: target.id,
          workflowRunId,
          headSha: runMeta?.headSha ?? '',
          status: AutogradeStatus.COMPLETED,
          score: parsed.score,
          maxScore: parsed.maxScore,
          startedAt: runMeta?.createdAt ?? null,
          completedAt: runMeta?.updatedAt ?? new Date(),
          rawResults: buildRawRecord(parsed.warnings, discrepancies, raw),
        },
        update: {
          status: AutogradeStatus.COMPLETED,
          score: parsed.score,
          maxScore: parsed.maxScore,
          completedAt: runMeta?.updatedAt ?? new Date(),
          rawResults: buildRawRecord(parsed.warnings, discrepancies, raw),
        },
        select: { id: true },
      })

      await tx.autogradeTestResult.deleteMany({ where: { runId: run.id } })
      await tx.autogradeTestResult.createMany({
        data: parsed.tests.map((test) => ({
          runId: run.id,
          gradingTestId: testIdByName.get(test.name) ?? null,
          name: test.name,
          passed: test.passed,
          points: test.points,
          maxPoints: test.maxPoints,
          output: test.outcome,
        })),
      })
    }
  })

  if (discrepancies.length > 0) {
    console.warn(
      `[jobs] autograde run ${workflowRunId} for ${repo.fullName} has discrepancies: ` +
        discrepancies.join(' '),
    )
  }
}

function buildRawRecord(
  warnings: string[],
  discrepancies: string[],
  raw: string,
): Prisma.InputJsonValue {
  // The raw file is kept so a disputed grade can be examined without re-running
  // the workflow, but bounded so a hostile artifact cannot bloat the database.
  return {
    warnings,
    discrepancies,
    raw: raw.slice(0, 100_000),
    truncated: raw.length > 100_000,
  }
}

/** Recorded against every row sharing the repository, for the same reason the results are. */
async function recordFailure(
  assignmentRepoIds: readonly string[],
  workflowRunId: bigint,
  message: string,
  raw?: string,
): Promise<void> {
  for (const assignmentRepoId of assignmentRepoIds) {
    await db.autogradeRun.upsert({
      where: { assignmentRepoId_workflowRunId: { assignmentRepoId, workflowRunId } },
      create: {
        assignmentRepoId,
        workflowRunId,
        headSha: '',
        status: AutogradeStatus.FAILED,
        completedAt: new Date(),
        rawResults: { error: message, ...(raw ? { raw: raw.slice(0, 10_000) } : {}) },
      },
      update: {
        status: AutogradeStatus.FAILED,
        completedAt: new Date(),
        rawResults: { error: message, ...(raw ? { raw: raw.slice(0, 10_000) } : {}) },
      },
    })
  }
}

/** Head SHA and timings for a run, for display. Best effort. */
async function findRunMetadata(
  installationId: bigint,
  org: string,
  repoName: string,
  workflowRunId: bigint,
): Promise<{ headSha: string; createdAt: Date; updatedAt: Date } | null> {
  try {
    const runs = await listWorkflowRuns(installationId, org, repoName, 100)
    const match = runs.find((run) => run.id === workflowRunId)
    if (!match) return null
    return {
      headSha: match.headSha,
      createdAt: new Date(match.createdAt),
      updatedAt: new Date(match.updatedAt),
    }
  } catch {
    // Metadata is a nicety; a missing head SHA must not lose the score.
    return null
  }
}

/**
 * Re-scan a repository's recent workflow runs and ingest any that are missing.
 *
 * The recovery path for a webhook that never arrived — the app was down, the
 * forwarding tunnel was closed, or the webhook was not configured yet. Without
 * this, a missed delivery would mean a permanently ungraded submission.
 */
export async function resyncAutogradeRuns(assignmentRepoId: string): Promise<{
  examined: number
  queued: number
}> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: assignmentRepoId },
    select: {
      githubRepoId: true,
      fullName: true,
      assignment: {
        select: {
          autogradeEnabled: true,
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  if (!repo?.fullName || !repo.githubRepoId || !repo.assignment.autogradeEnabled) {
    return { examined: 0, queued: 0 }
  }

  const org = repo.assignment.classroom.githubOrgLogin
  const installationId = repo.assignment.classroom.installationId
  const repoName = repo.fullName.split('/')[1]

  const runs = await listWorkflowRuns(installationId, org, repoName, 50)
  const completed = runs.filter((run) => run.status === 'completed')

  // Scoped to this row. A run ingested for a student who shares the repository says
  // nothing about whether *this* student has it, and the composite key means the two
  // are genuinely separate rows.
  const known = await db.autogradeRun.findMany({
    where: {
      assignmentRepoId,
      workflowRunId: { in: completed.map((r) => r.id) },
      status: AutogradeStatus.COMPLETED,
    },
    select: { workflowRunId: true },
  })
  const knownIds = new Set(known.map((k) => k.workflowRunId))

  const missing = completed.filter((run) => !knownIds.has(run.id))

  const { enqueue, QUEUES } = await import('./queue')
  for (const run of missing) {
    await enqueue(
      QUEUES.ingestAutogradeRun,
      { githubRepoId: String(repo.githubRepoId), workflowRunId: String(run.id) },
      { singletonKey: `autograde:${run.id}` },
    )
  }

  return { examined: completed.length, queued: missing.length }
}
