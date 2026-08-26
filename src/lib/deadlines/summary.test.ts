import { describe, expect, it } from 'vitest'

import { summarizeSubmission } from './summary'

const DEADLINE = new Date('2026-03-01T23:59:00Z')
const base = { assignmentDeadline: DEADLINE, extensionDeadline: null, lockOnDeadline: false }
const noRepo = { deadlineSha: null, lockedAt: null, lastPushedAt: null }

describe('summarizeSubmission', () => {
  it('keeps "not captured" and "captured nothing" apart', () => {
    // The distinction decides what a student is told: one means "we have not looked
    // yet", the other means "you submitted nothing". Collapsing them to a falsy sha
    // would report an un-run sweep as a missed assignment.
    expect(summarizeSubmission(base, noRepo).sha).toBeNull()
    expect(summarizeSubmission(base, { ...noRepo, deadlineSha: '' }).sha).toBe('')
  })

  it('judges lateness on the last push, not on the current time', () => {
    const onTime = summarizeSubmission(base, {
      ...noRepo,
      lastPushedAt: new Date('2026-03-01T20:00:00Z'),
    })
    expect(onTime.late).toBe(false)

    const late = summarizeSubmission(base, {
      ...noRepo,
      lastPushedAt: new Date('2026-03-02T00:30:00Z'),
    })
    expect(late.late).toBe(true)
  })

  it('reports the extended deadline, and that it was extended', () => {
    const extended = new Date('2026-03-05T23:59:00Z')
    const result = summarizeSubmission(
      { ...base, extensionDeadline: extended },
      { ...noRepo, lastPushedAt: new Date('2026-03-03T12:00:00Z') },
    )

    expect(result.extended).toBe(true)
    expect(result.deadline).toBe(extended.toISOString())
    // A push after the original deadline but before the extended one is on time.
    expect(result.late).toBe(false)
  })

  it('has no deadline, and nothing late, when the assignment has none', () => {
    const result = summarizeSubmission(
      { assignmentDeadline: null, extensionDeadline: null, lockOnDeadline: false },
      { ...noRepo, lastPushedAt: new Date('2026-03-02T00:30:00Z') },
    )
    expect(result.deadline).toBeNull()
    expect(result.late).toBe(false)
  })

  it('reports locking from lockedAt', () => {
    expect(summarizeSubmission(base, noRepo).locked).toBe(false)
    expect(summarizeSubmission(base, { ...noRepo, lockedAt: new Date() }).locked).toBe(true)
  })
})
