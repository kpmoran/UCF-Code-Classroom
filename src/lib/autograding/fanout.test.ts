import { describe, expect, it } from 'vitest'

import { alreadyFullyIngested, selectAutogradeTargets } from './fanout'

function row(over: Partial<{ id: string; fullName: string | null; autograde: boolean }> = {}) {
  return {
    id: over.id ?? 'r1',
    fullName: over.fullName === undefined ? 'org/project' : over.fullName,
    assignment: { autogradeEnabled: over.autograde ?? true },
  }
}

describe('selectAutogradeTargets', () => {
  it('returns every row sharing a provisioned repository', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]
    expect(selectAutogradeTargets(rows).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  /*
   * The silent-failure case this exists to prevent: recording against only the first
   * row leaves the other students on a shared repository with no grade at all.
   */
  it('does not collapse a shared repository to one row', () => {
    expect(selectAutogradeTargets([row({ id: 'a' }), row({ id: 'b' })])).toHaveLength(2)
  })

  it('skips a row that has no repository yet', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', fullName: null })]
    expect(selectAutogradeTargets(rows).map((r) => r.id)).toEqual(['a'])
  })

  it('skips a row whose assignment has autograding switched off', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', autograde: false })]
    expect(selectAutogradeTargets(rows).map((r) => r.id)).toEqual(['a'])
  })

  it('returns nothing when no row qualifies', () => {
    expect(selectAutogradeTargets([row({ autograde: false })])).toEqual([])
  })
})

describe('alreadyFullyIngested', () => {
  it('skips when every target already has the run', () => {
    expect(alreadyFullyIngested({ targetCount: 3, completedCount: 3 })).toBe(true)
  })

  /*
   * The retry case: ingestion died after writing one of three rows. Skipping here
   * would leave the other two students permanently ungraded.
   */
  it('does not skip when only some targets have it', () => {
    expect(alreadyFullyIngested({ targetCount: 3, completedCount: 1 })).toBe(false)
  })

  it('does not skip when none have it', () => {
    expect(alreadyFullyIngested({ targetCount: 2, completedCount: 0 })).toBe(false)
  })

  it('treats no targets as nothing to do', () => {
    expect(alreadyFullyIngested({ targetCount: 0, completedCount: 0 })).toBe(true)
  })
})
