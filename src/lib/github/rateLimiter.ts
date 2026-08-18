import 'server-only'

import { db } from '@/lib/db'
import { env } from '@/lib/env'

import {
  applyBackoff,
  estimateDurationMs,
  initialState,
  tryConsume,
  type BucketConfig,
  type BucketState,
} from './bucket'

/**
 * Persistent, cross-process rate limiting for GitHub's content-creating
 * requests.
 *
 * The budget lives in Postgres rather than in memory because several worker
 * processes (and, in development, several `next dev` recompiles) share one
 * GitHub installation. An in-memory bucket per process would multiply the
 * allowance by the number of processes and get the whole installation blocked.
 *
 * Each acquisition takes a row lock, so concurrent workers serialize on the
 * budget row. That is intentional: the lock is held for microseconds, and the
 * alternative is two workers both believing they had the last token.
 */

export const bucketConfig: BucketConfig = {
  perMinute: env.GITHUB_CONTENT_CALLS_PER_MINUTE,
  perHour: env.GITHUB_CONTENT_CALLS_PER_HOUR,
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number; reason: 'minute' | 'hour' | 'blocked' }

type BudgetRow = {
  installationId: bigint
  minuteTokens: number
  hourTokens: number
  minuteRefillAt: Date
  hourRefillAt: Date
  blockedUntil: Date | null
}

function toState(row: BudgetRow): BucketState {
  return {
    minuteTokens: row.minuteTokens,
    hourTokens: row.hourTokens,
    minuteRefillAt: row.minuteRefillAt,
    hourRefillAt: row.hourRefillAt,
    blockedUntil: row.blockedUntil,
  }
}

/**
 * Try to reserve budget for `cost` content-creating calls.
 *
 * Callers must respect a refusal by rescheduling; ignoring it and calling
 * GitHub anyway is what causes the installation-wide 403 this exists to avoid.
 */
export async function acquireContentBudget(
  installationId: bigint,
  cost = 1,
): Promise<AcquireResult> {
  const now = new Date()

  return db.$transaction(async (tx) => {
    // FOR UPDATE serializes concurrent workers on this installation's budget.
    const rows = await tx.$queryRaw<BudgetRow[]>`
      SELECT "installationId", "minuteTokens", "hourTokens",
             "minuteRefillAt", "hourRefillAt", "blockedUntil"
      FROM "github_rate_budgets"
      WHERE "installationId" = ${installationId}
      FOR UPDATE
    `

    const state = rows.length > 0 ? toState(rows[0]) : initialState(bucketConfig, now)
    const result = tryConsume(state, bucketConfig, now, cost)

    await tx.githubRateBudget.upsert({
      where: { installationId },
      create: {
        installationId,
        minuteTokens: result.state.minuteTokens,
        hourTokens: result.state.hourTokens,
        minuteRefillAt: result.state.minuteRefillAt,
        hourRefillAt: result.state.hourRefillAt,
        blockedUntil: result.state.blockedUntil,
      },
      update: {
        minuteTokens: result.state.minuteTokens,
        hourTokens: result.state.hourTokens,
        minuteRefillAt: result.state.minuteRefillAt,
        hourRefillAt: result.state.hourRefillAt,
        blockedUntil: result.state.blockedUntil,
      },
    })

    if (result.ok) return { ok: true as const }
    return { ok: false as const, retryAfterMs: result.retryAfterMs, reason: result.reason }
  })
}

/**
 * Record that GitHub rate limited us, pausing every worker on this
 * installation until the deadline GitHub gave.
 */
export async function reportRateLimited(
  installationId: bigint,
  retryAfterMs: number,
): Promise<void> {
  const now = new Date()

  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<BudgetRow[]>`
      SELECT "installationId", "minuteTokens", "hourTokens",
             "minuteRefillAt", "hourRefillAt", "blockedUntil"
      FROM "github_rate_budgets"
      WHERE "installationId" = ${installationId}
      FOR UPDATE
    `

    const state = rows.length > 0 ? toState(rows[0]) : initialState(bucketConfig, now)
    const next = applyBackoff(state, now, retryAfterMs)

    await tx.githubRateBudget.upsert({
      where: { installationId },
      create: { installationId, ...next },
      update: { blockedUntil: next.blockedUntil },
    })
  })
}

/** Current budget, for the provisioning-status UI. */
export async function getBudgetStatus(installationId: bigint) {
  const row = await db.githubRateBudget.findUnique({ where: { installationId } })
  const now = new Date()
  const state = row ? toState(row as BudgetRow) : initialState(bucketConfig, now)

  return {
    config: bucketConfig,
    minuteTokens: Math.floor(state.minuteTokens),
    hourTokens: Math.floor(state.hourTokens),
    blockedUntil: state.blockedUntil,
    isBlocked: Boolean(state.blockedUntil && state.blockedUntil > now),
  }
}

/**
 * How long `callCount` calls will take, for the "this will take ~40 minutes"
 * message on bulk provisioning.
 */
export function estimateProvisioningMs(callCount: number): number {
  return estimateDurationMs(bucketConfig, callCount)
}

/** Human-readable duration, e.g. "about 45 minutes". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'less than a minute'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes === 1) return 'about a minute'
  if (minutes < 60) return `about ${minutes} minutes`

  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`
  if (rem === 0) return `about ${hourPart}`
  return `about ${hourPart} ${rem} minutes`
}
