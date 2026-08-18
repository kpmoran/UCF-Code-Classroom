import { describe, expect, it } from 'vitest'

import {
  decideDeadlineAction,
  describeDeadline,
  effectiveDeadline,
  isLateSubmission,
  isPastDeadline,
  type DeadlineInput,
  type RepoDeadlineState,
} from './resolve'

const DEADLINE = new Date('2026-09-15T23:59:00.000Z')
const BEFORE = new Date('2026-09-15T20:00:00.000Z')
const AFTER = new Date('2026-09-16T00:30:00.000Z')

function input(over: Partial<DeadlineInput> = {}): DeadlineInput {
  return {
    assignmentDeadline: DEADLINE,
    extensionDeadline: null,
    lockOnDeadline: false,
    ...over,
  }
}

function state(over: Partial<RepoDeadlineState> = {}): RepoDeadlineState {
  return { lockedAt: null, deadlineSha: null, lastPushedAt: null, ...over }
}

describe('effectiveDeadline', () => {
  it('uses the assignment deadline when there is no extension', () => {
    expect(effectiveDeadline(input())).toEqual(DEADLINE)
  })

  it('prefers an extension', () => {
    const later = new Date('2026-09-20T23:59:00.000Z')
    expect(effectiveDeadline(input({ extensionDeadline: later }))).toEqual(later)
  })

  it('honours an extension that moves the deadline earlier', () => {
    // An instructor setting an earlier date for one student did so on purpose;
    // silently ignoring it would be worse than honouring it.
    const earlier = new Date('2026-09-10T23:59:00.000Z')
    expect(effectiveDeadline(input({ extensionDeadline: earlier }))).toEqual(earlier)
  })

  it('returns null when neither is set', () => {
    expect(effectiveDeadline(input({ assignmentDeadline: null }))).toBeNull()
  })

  it('applies an extension even when the assignment has no deadline', () => {
    const only = new Date('2026-09-20T23:59:00.000Z')
    expect(
      effectiveDeadline(input({ assignmentDeadline: null, extensionDeadline: only })),
    ).toEqual(only)
  })
})

describe('isPastDeadline', () => {
  it('is false before and true after', () => {
    expect(isPastDeadline(input(), BEFORE)).toBe(false)
    expect(isPastDeadline(input(), AFTER)).toBe(true)
  })

  it('treats the exact deadline instant as passed', () => {
    // "Due at 23:59" means 23:59:00.000 is the cutoff, not a free extra minute.
    expect(isPastDeadline(input(), DEADLINE)).toBe(true)
    expect(isPastDeadline(input(), new Date(DEADLINE.getTime() - 1))).toBe(false)
  })

  it('is never past when there is no deadline', () => {
    expect(isPastDeadline(input({ assignmentDeadline: null }), AFTER)).toBe(false)
  })
})

describe('isLateSubmission', () => {
  it('is based on the push time, not the current time', () => {
    // Work submitted on time must not become "late" just because the deadline
    // has since passed.
    const onTime = state({ lastPushedAt: BEFORE })
    expect(isLateSubmission(input(), onTime)).toBe(false)
  })

  it('flags a push after the deadline', () => {
    expect(isLateSubmission(input(), state({ lastPushedAt: AFTER }))).toBe(true)
  })

  it('is not late when an extension covers the push', () => {
    const extended = input({ extensionDeadline: new Date('2026-09-20T23:59:00.000Z') })
    expect(isLateSubmission(extended, state({ lastPushedAt: AFTER }))).toBe(false)
  })

  it('is not late with no pushes or no deadline', () => {
    expect(isLateSubmission(input(), state({ lastPushedAt: null }))).toBe(false)
    expect(
      isLateSubmission(input({ assignmentDeadline: null }), state({ lastPushedAt: AFTER })),
    ).toBe(false)
  })

  it('treats a push exactly at the deadline as on time', () => {
    expect(isLateSubmission(input(), state({ lastPushedAt: DEADLINE }))).toBe(false)
  })
})

describe('decideDeadlineAction — before the deadline', () => {
  it('does nothing', () => {
    expect(decideDeadlineAction(input(), state(), BEFORE)).toEqual({ kind: 'none' })
  })

  it('unlocks a repository locked before its (extended) deadline', () => {
    // This is what an extension granted after locking looks like: the deadline is
    // now in the future but the repository is still locked.
    const extended = input({
      lockOnDeadline: true,
      extensionDeadline: new Date('2026-09-20T23:59:00.000Z'),
    })
    const result = decideDeadlineAction(extended, state({ lockedAt: AFTER }), AFTER)
    expect(result.kind).toBe('unlock')
    if (result.kind === 'unlock') expect(result.reason).toMatch(/extended/)
  })
})

describe('decideDeadlineAction — after the deadline', () => {
  it('captures the submitted commit even when locking is off', () => {
    // Recording the on-time state while letting students keep working is the
    // common arrangement, so capture must not depend on locking.
    const result = decideDeadlineAction(input({ lockOnDeadline: false }), state(), AFTER)
    expect(result.kind).toBe('capture')
  })

  it('captures and locks together when locking is on', () => {
    const result = decideDeadlineAction(input({ lockOnDeadline: true }), state(), AFTER)
    expect(result.kind).toBe('capture-and-lock')
  })

  it('locks when the commit was already captured', () => {
    const result = decideDeadlineAction(
      input({ lockOnDeadline: true }),
      state({ deadlineSha: 'abc123' }),
      AFTER,
    )
    expect(result.kind).toBe('lock')
  })

  it('does nothing once captured and locked', () => {
    // Idempotence: the sweep runs repeatedly and must not re-lock every time.
    const result = decideDeadlineAction(
      input({ lockOnDeadline: true }),
      state({ deadlineSha: 'abc123', lockedAt: AFTER }),
      AFTER,
    )
    expect(result).toEqual({ kind: 'none' })
  })

  it('does nothing once captured when locking is off', () => {
    const result = decideDeadlineAction(
      input({ lockOnDeadline: false }),
      state({ deadlineSha: 'abc123' }),
      AFTER,
    )
    expect(result).toEqual({ kind: 'none' })
  })

  it('unlocks when locking is turned off after the fact', () => {
    const result = decideDeadlineAction(
      input({ lockOnDeadline: false }),
      state({ deadlineSha: 'abc123', lockedAt: AFTER }),
      AFTER,
    )
    expect(result.kind).toBe('unlock')
    if (result.kind === 'unlock') expect(result.reason).toMatch(/turned off/)
  })
})

describe('decideDeadlineAction — no deadline', () => {
  it('does nothing when there never was one', () => {
    expect(
      decideDeadlineAction(input({ assignmentDeadline: null }), state(), AFTER),
    ).toEqual({ kind: 'none' })
  })

  it('unlocks when the deadline was removed', () => {
    const result = decideDeadlineAction(
      input({ assignmentDeadline: null, lockOnDeadline: true }),
      state({ lockedAt: AFTER }),
      AFTER,
    )
    expect(result.kind).toBe('unlock')
    if (result.kind === 'unlock') expect(result.reason).toMatch(/removed/)
  })
})

describe('describeDeadline', () => {
  it('reports no deadline', () => {
    expect(describeDeadline(input({ assignmentDeadline: null }), state(), BEFORE)).toEqual({
      label: 'No deadline',
      tone: 'neutral',
    })
  })

  it('warns as the deadline approaches', () => {
    const result = describeDeadline(input(), state(), new Date('2026-09-15T18:00:00.000Z'))
    expect(result.tone).toBe('warning')
    expect(result.label).toMatch(/Due in \d+ hours/)
  })

  it('says under an hour rather than rounding to zero', () => {
    const result = describeDeadline(input(), state(), new Date('2026-09-15T23:30:00.000Z'))
    expect(result.label).toBe('Due in under an hour')
  })

  it('marks a late submission over a merely-past deadline', () => {
    const late = describeDeadline(input(), state({ lastPushedAt: AFTER }), AFTER)
    expect(late).toEqual({ label: 'Submitted late', tone: 'danger' })

    const noPush = describeDeadline(input(), state(), AFTER)
    expect(noPush).toEqual({ label: 'Past due', tone: 'warning' })
  })

  it('distinguishes an expired extension from an ordinary past deadline', () => {
    const expired = describeDeadline(
      input({ extensionDeadline: new Date('2026-09-16T00:00:00.000Z') }),
      state(),
      AFTER,
    )
    expect(expired.label).toBe('Extension expired')
  })

  it('says "Extended to" when an extension is in force', () => {
    const result = describeDeadline(
      input({ extensionDeadline: new Date('2026-09-30T23:59:00.000Z') }),
      state(),
      BEFORE,
    )
    expect(result.label).toMatch(/^Extended to/)
  })
})
