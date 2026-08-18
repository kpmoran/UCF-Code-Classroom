import { describe, expect, it } from 'vitest'

import { parseDeadline } from '@/lib/assignments/schemas'

import { toDateTimeLocal } from './format'

describe('toDateTimeLocal', () => {
  it('formats local wall-clock time, not UTC', () => {
    // Constructed from local components, so the output must match them exactly
    // whatever zone the machine is in. `toISOString().slice(0,16)` fails this.
    const date = new Date(2026, 8, 15, 23, 59)
    expect(toDateTimeLocal(date)).toBe('2026-09-15T23:59')
  })

  it('zero-pads every component', () => {
    const date = new Date(2026, 0, 5, 4, 7)
    expect(toDateTimeLocal(date)).toBe('2026-01-05T04:07')
  })

  it('omits seconds, which the input does not accept', () => {
    const date = new Date(2026, 8, 15, 23, 59, 45)
    expect(toDateTimeLocal(date)).toBe('2026-09-15T23:59')
  })

  it('returns empty for no deadline', () => {
    expect(toDateTimeLocal(null)).toBe('')
    expect(toDateTimeLocal(undefined)).toBe('')
  })

  it('returns empty rather than "NaN-NaN-NaN" for an invalid date', () => {
    expect(toDateTimeLocal(new Date('nonsense'))).toBe('')
  })

  it('round-trips through the form parser without shifting the time', () => {
    // The real invariant: rendering a stored deadline into the form and saving it
    // unchanged must not move it. A UTC-based formatter breaks this by the size of
    // the local offset, which is exactly the kind of bug that quietly grants or
    // steals hours from students.
    const original = new Date(2026, 8, 15, 23, 59)
    const rendered = toDateTimeLocal(original)
    const reparsed = parseDeadline(rendered)

    expect(reparsed).toBeInstanceOf(Date)
    expect((reparsed as Date).getTime()).toBe(original.getTime())
  })

  it('round-trips across a range of times of day', () => {
    for (const hour of [0, 1, 11, 12, 13, 23]) {
      const original = new Date(2026, 5, 30, hour, 30)
      const reparsed = parseDeadline(toDateTimeLocal(original))
      expect((reparsed as Date).getTime(), `hour ${hour}`).toBe(original.getTime())
    }
  })
})
