import { describe, expect, it } from 'vitest'

import {
  applyBackoff,
  estimateDurationMs,
  initialState,
  refill,
  tryConsume,
  type BucketConfig,
} from './bucket'

const CONFIG: BucketConfig = { perMinute: 6, perHour: 400 }
const T0 = new Date('2026-08-17T12:00:00.000Z')

function at(msFromT0: number) {
  return new Date(T0.getTime() + msFromT0)
}

describe('initialState', () => {
  it('starts full', () => {
    const s = initialState(CONFIG, T0)
    expect(s.minuteTokens).toBe(6)
    expect(s.hourTokens).toBe(400)
    expect(s.blockedUntil).toBeNull()
  })
})

describe('tryConsume', () => {
  it('spends from both buckets', () => {
    const r = tryConsume(initialState(CONFIG, T0), CONFIG, T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.state.minuteTokens).toBe(5)
    expect(r.state.hourTokens).toBe(399)
  })

  it('exhausts the minute bucket after perMinute calls at the same instant', () => {
    let state = initialState(CONFIG, T0)
    for (let i = 0; i < 6; i++) {
      const r = tryConsume(state, CONFIG, T0)
      expect(r.ok).toBe(true)
      state = r.state
    }

    const denied = tryConsume(state, CONFIG, T0)
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.reason).toBe('minute')
    // One token accrues every 10s at 6/min.
    expect(denied.retryAfterMs).toBe(10_000)
  })

  it('refills continuously rather than in discrete windows', () => {
    let state = initialState(CONFIG, T0)
    for (let i = 0; i < 6; i++) state = (tryConsume(state, CONFIG, T0) as { state: typeof state }).state

    // After 10s exactly one token is available, and only one.
    const first = tryConsume(state, CONFIG, at(10_000))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = tryConsume(first.state, CONFIG, at(10_000))
    expect(second.ok).toBe(false)
  })

  it('never accrues past capacity while idle', () => {
    const idle = refill(initialState(CONFIG, T0), CONFIG, at(24 * 3_600_000))
    expect(idle.minuteTokens).toBe(6)
    expect(idle.hourTokens).toBe(400)
  })

  it('refuses on the hour bucket even when the minute bucket has room', () => {
    // Hand-construct a state where only the hourly allowance is spent, which is
    // exactly the 400-repos-in-one-afternoon case.
    const state = {
      minuteTokens: 6,
      hourTokens: 0.5,
      minuteRefillAt: T0,
      hourRefillAt: T0,
      blockedUntil: null,
    }
    const r = tryConsume(state, CONFIG, T0)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('hour')
    // 0.5 tokens short at 400/hour = 4.5s.
    expect(r.retryAfterMs).toBe(4_500)
  })

  it('supports a multi-token cost', () => {
    const r = tryConsume(initialState(CONFIG, T0), CONFIG, T0, 4)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.state.minuteTokens).toBe(2)

    const tooBig = tryConsume(r.state, CONFIG, T0, 3)
    expect(tooBig.ok).toBe(false)
  })
})

describe('applyBackoff', () => {
  it('blocks all consumption until the deadline', () => {
    const blocked = applyBackoff(initialState(CONFIG, T0), T0, 60_000)
    const r = tryConsume(blocked, CONFIG, at(30_000))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('blocked')
    expect(r.retryAfterMs).toBe(30_000)
  })

  it('allows consumption once the block expires', () => {
    const blocked = applyBackoff(initialState(CONFIG, T0), T0, 60_000)
    expect(tryConsume(blocked, CONFIG, at(60_001)).ok).toBe(true)
  })

  it('never shortens an existing block', () => {
    // Two workers get different Retry-After values; the longer must win, or the
    // second worker's optimism resumes traffic while GitHub is still blocking.
    const long = applyBackoff(initialState(CONFIG, T0), T0, 300_000)
    const shortened = applyBackoff(long, T0, 10_000)
    expect(shortened.blockedUntil).toEqual(long.blockedUntil)
  })
})

describe('estimateDurationMs', () => {
  it('is instant for a burst within the minute capacity', () => {
    expect(estimateDurationMs(CONFIG, 6)).toBe(0)
  })

  it('paces the remainder at the slower sustained rate', () => {
    // 400/hour = 1 per 9s is slower than 6/min = 1 per 10s? No: 6/min is
    // 1 per 10s, 400/hour is 1 per 9s. The minute bucket is the constraint.
    // 106 calls: 6 immediate, 100 paced at 10s each.
    expect(estimateDurationMs(CONFIG, 106)).toBe(1_000_000)
  })

  it('reflects a real 200-student bulk provision', () => {
    // Two calls per student: generate the repo, invite the collaborator.
    const ms = estimateDurationMs(CONFIG, 400)
    // Comfortably over half an hour — the number the UI must show so nobody
    // assumes the job has hung.
    expect(ms).toBeGreaterThan(30 * 60_000)
  })

  it('is zero for no work', () => {
    expect(estimateDurationMs(CONFIG, 0)).toBe(0)
    expect(estimateDurationMs(CONFIG, -5)).toBe(0)
  })
})
