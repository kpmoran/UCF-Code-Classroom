/**
 * Dual token-bucket arithmetic for GitHub's secondary rate limits.
 *
 * GitHub allows roughly 80 content-creating requests per minute and 500 per
 * hour. Two buckets are needed, not one: a per-minute bucket alone would let a
 * steady 6/min drain the hourly allowance in 80 minutes and then fail, and an
 * hourly bucket alone would permit a 400-call burst that trips the per-minute
 * limit immediately. A request must have room in *both*.
 *
 * Kept pure — no clock, no database — so the refill and exhaustion behaviour is
 * directly testable. The persistence wrapper lives in rateLimiter.ts.
 */

export type BucketConfig = {
  /** Bucket capacity and hourly/minutely refill target. */
  perMinute: number
  perHour: number
}

export type BucketState = {
  minuteTokens: number
  hourTokens: number
  /** Last time each bucket was refilled. */
  minuteRefillAt: Date
  hourRefillAt: Date
  /** Hard stop from a 403 + Retry-After; no request until this passes. */
  blockedUntil: Date | null
}

export function initialState(config: BucketConfig, now: Date): BucketState {
  return {
    minuteTokens: config.perMinute,
    hourTokens: config.perHour,
    minuteRefillAt: now,
    hourRefillAt: now,
    blockedUntil: null,
  }
}

/**
 * Bring a stored state up to date. Tokens accrue continuously rather than in
 * discrete windows, which avoids the thundering herd where every worker fires
 * at the top of each minute.
 */
export function refill(state: BucketState, config: BucketConfig, now: Date): BucketState {
  const minuteElapsedMs = Math.max(0, now.getTime() - state.minuteRefillAt.getTime())
  const hourElapsedMs = Math.max(0, now.getTime() - state.hourRefillAt.getTime())

  const minuteGain = (minuteElapsedMs / 60_000) * config.perMinute
  const hourGain = (hourElapsedMs / 3_600_000) * config.perHour

  return {
    ...state,
    minuteTokens: Math.min(config.perMinute, state.minuteTokens + minuteGain),
    hourTokens: Math.min(config.perHour, state.hourTokens + hourGain),
    minuteRefillAt: now,
    hourRefillAt: now,
  }
}

export type ConsumeResult =
  | { ok: true; state: BucketState }
  | { ok: false; state: BucketState; retryAfterMs: number; reason: 'minute' | 'hour' | 'blocked' }

/**
 * Attempt to spend `cost` tokens.
 *
 * On refusal, `retryAfterMs` is how long until the scarcer bucket has enough —
 * computed rather than guessed, so a job can reschedule itself precisely
 * instead of polling.
 */
export function tryConsume(
  state: BucketState,
  config: BucketConfig,
  now: Date,
  cost = 1,
): ConsumeResult {
  if (state.blockedUntil && state.blockedUntil.getTime() > now.getTime()) {
    return {
      ok: false,
      state,
      retryAfterMs: state.blockedUntil.getTime() - now.getTime(),
      reason: 'blocked',
    }
  }

  const current = refill(state, config, now)

  if (current.minuteTokens < cost) {
    const deficit = cost - current.minuteTokens
    return {
      ok: false,
      state: current,
      retryAfterMs: Math.ceil((deficit / config.perMinute) * 60_000),
      reason: 'minute',
    }
  }

  if (current.hourTokens < cost) {
    const deficit = cost - current.hourTokens
    return {
      ok: false,
      state: current,
      retryAfterMs: Math.ceil((deficit / config.perHour) * 3_600_000),
      reason: 'hour',
    }
  }

  return {
    ok: true,
    state: {
      ...current,
      minuteTokens: current.minuteTokens - cost,
      hourTokens: current.hourTokens - cost,
    },
  }
}

/** Record a rate-limit rejection from GitHub, pausing all further calls. */
export function applyBackoff(state: BucketState, now: Date, retryAfterMs: number): BucketState {
  const until = new Date(now.getTime() + retryAfterMs)
  // Never shorten an existing block: two workers reporting different
  // Retry-After values should settle on the more conservative one.
  const blockedUntil =
    state.blockedUntil && state.blockedUntil > until ? state.blockedUntil : until
  return { ...state, blockedUntil }
}

/**
 * Estimated wall-clock time to perform `callCount` content-creating requests
 * from a full bucket, used to show a provisioning ETA. Returns milliseconds.
 */
export function estimateDurationMs(config: BucketConfig, callCount: number): number {
  if (callCount <= 0) return 0

  // The first `perMinute` calls go out immediately from the full bucket; the
  // remainder are paced by whichever refill rate is slower.
  const minuteRatePerMs = config.perMinute / 60_000
  const hourRatePerMs = config.perHour / 3_600_000
  const sustainedRate = Math.min(minuteRatePerMs, hourRatePerMs)

  const burst = Math.min(callCount, config.perMinute)
  const remaining = callCount - burst
  if (remaining <= 0) return 0

  return Math.ceil(remaining / sustainedRate)
}
