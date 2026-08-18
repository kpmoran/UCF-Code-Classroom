import { describe, expect, it } from 'vitest'

import { diffIsEmpty, diffRoster, type ExistingRosterEntry } from './diffRoster'
import type { ParsedRosterRow } from './parseRoster'

function parsed(over: Partial<ParsedRosterRow> = {}): ParsedRosterRow {
  return {
    displayName: 'Alvarez, Ava',
    sisUserId: '30000001',
    sisLoginId: 'av123456',
    email: null,
    section: 'COP4331-0001',
    rawColumns: {},
    ...over,
  }
}

function existing(over: Partial<ExistingRosterEntry> = {}): ExistingRosterEntry {
  return {
    id: 'e1',
    displayName: 'Alvarez, Ava',
    sisUserId: '30000001',
    sisLoginId: 'av123456',
    email: null,
    section: 'COP4331-0001',
    claimedByUserId: null,
    claimedByLogin: null,
    removedAt: null,
    repoCount: 0,
    ...over,
  }
}

describe('diffRoster — basic classification', () => {
  it('reports an unchanged match', () => {
    const diff = diffRoster([parsed()], [existing()])
    expect(diff.unchanged).toHaveLength(1)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diffIsEmpty(diff)).toBe(true)
  })

  it('reports an addition', () => {
    const diff = diffRoster([parsed({ sisUserId: '30000002', displayName: 'Bennett, Noah' })], [])
    expect(diff.added).toHaveLength(1)
    expect(diffIsEmpty(diff)).toBe(false)
  })

  it('reports a removal', () => {
    const diff = diffRoster([], [existing()])
    expect(diff.removed).toHaveLength(1)
    expect(diff.destructive).toHaveLength(0)
  })

  it('reports field updates with before and after', () => {
    const diff = diffRoster(
      [parsed({ section: 'COP4331-0002', displayName: 'Alvarez, Ava M.' })],
      [existing()],
    )
    expect(diff.updated).toHaveLength(1)
    expect(diff.updated[0].changes).toEqual(
      expect.arrayContaining([
        { field: 'displayName', from: 'Alvarez, Ava', to: 'Alvarez, Ava M.' },
        { field: 'section', from: 'COP4331-0001', to: 'COP4331-0002' },
      ]),
    )
  })
})

describe('diffRoster — matching strategy', () => {
  it('prefers SIS User ID even when the name changed', () => {
    // A student who changes their legal name must not read as drop + add.
    const diff = diffRoster(
      [parsed({ displayName: 'Newname, Ava' })],
      [existing({ displayName: 'Alvarez, Ava' })],
    )
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.updated).toHaveLength(1)
    expect(diff.matchedBy.sisUserId).toBe(1)
  })

  it('falls back to SIS Login ID when there is no SIS User ID', () => {
    const diff = diffRoster(
      [parsed({ sisUserId: null, displayName: 'Different, Name' })],
      [existing({ sisUserId: null })],
    )
    expect(diff.matchedBy.sisLoginId).toBe(1)
    expect(diff.added).toHaveLength(0)
  })

  it('falls back to display name as a last resort, case-insensitively', () => {
    const diff = diffRoster(
      [parsed({ sisUserId: null, sisLoginId: null, displayName: 'alvarez, ava' })],
      [existing({ sisUserId: null, sisLoginId: null })],
    )
    expect(diff.matchedBy.displayName).toBe(1)
    expect(diff.added).toHaveLength(0)
  })

  it('does not match one existing entry to two CSV rows', () => {
    // Two students genuinely sharing a name: the second must be an addition,
    // not a silent overwrite of the first.
    const rows = [
      parsed({ sisUserId: null, sisLoginId: null, displayName: 'Smith, John' }),
      parsed({ sisUserId: null, sisLoginId: null, displayName: 'Smith, John' }),
    ]
    const diff = diffRoster(rows, [
      existing({ sisUserId: null, sisLoginId: null, displayName: 'Smith, John' }),
    ])
    expect(diff.unchanged).toHaveLength(1)
    expect(diff.added).toHaveLength(1)
  })
})

describe('diffRoster — protecting registered students', () => {
  it('flags a removal that would unlink a registered student', () => {
    const diff = diffRoster(
      [],
      [existing({ claimedByUserId: 'u1', claimedByLogin: 'ava-dev' })],
    )
    expect(diff.removed).toHaveLength(1)
    expect(diff.destructive).toHaveLength(1)
    expect(diff.destructive[0].consequence).toContain('@ava-dev')
    expect(diff.destructive[0].consequence).toContain('unlink')
  })

  it('states the repository count when the student has provisioned repos', () => {
    // This is the case an instructor must see before confirming: a wrong CSV
    // would otherwise quietly cut students off from work they have done.
    const diff = diffRoster(
      [],
      [existing({ claimedByUserId: 'u1', claimedByLogin: 'ava-dev', repoCount: 3 })],
    )
    expect(diff.destructive[0].consequence).toContain('3 assignment repositories')
    expect(diff.destructive[0].consequence).toContain('does not delete anything on GitHub')
  })

  it('does not flag removal of an unregistered entry as destructive', () => {
    const diff = diffRoster([], [existing()])
    expect(diff.removed).toHaveLength(1)
    expect(diff.destructive).toHaveLength(0)
  })

  it('uses the singular for exactly one repository', () => {
    const diff = diffRoster([], [existing({ claimedByUserId: 'u1', repoCount: 1 })])
    expect(diff.destructive[0].consequence).toContain('1 assignment repository')
  })
})

describe('diffRoster — re-adds and soft deletion', () => {
  it('restores a previously removed student instead of duplicating them', () => {
    // A student who drops and re-adds keeps their claim and their repositories.
    const diff = diffRoster([parsed()], [existing({ removedAt: new Date('2026-08-01') })])
    expect(diff.restored).toHaveLength(1)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
  })

  it('ignores an already-removed entry that is still absent', () => {
    const diff = diffRoster([], [existing({ removedAt: new Date('2026-08-01') })])
    expect(diff.removed).toHaveLength(0)
    expect(diffIsEmpty(diff)).toBe(true)
  })
})

describe('diffRoster — not blanking existing data', () => {
  it('does not treat a missing CSV value as a change to null', () => {
    // An export without SIS permission has no login id; that must not wipe the
    // one we already have.
    const diff = diffRoster(
      [parsed({ sisLoginId: null, email: null, section: null })],
      [existing({ sisLoginId: 'av123456', email: 'a@b.c', section: 'COP4331-0001' })],
    )
    expect(diff.updated).toHaveLength(0)
    expect(diff.unchanged).toHaveLength(1)
  })

  it('does fill in a value that was previously missing', () => {
    const diff = diffRoster(
      [parsed({ email: 'ava@knights.ucf.edu' })],
      [existing({ email: null })],
    )
    expect(diff.updated).toHaveLength(1)
    expect(diff.updated[0].changes).toEqual([
      { field: 'email', from: null, to: 'ava@knights.ucf.edu' },
    ])
  })

  it('ignores whitespace-only differences', () => {
    const diff = diffRoster([parsed({ section: '  COP4331-0001  ' })], [existing()])
    expect(diff.updated).toHaveLength(0)
  })
})

describe('diffRoster — mixed realistic import', () => {
  it('classifies a whole roster change set', () => {
    const existingRoster = [
      existing({ id: 'e1', sisUserId: '1', displayName: 'Keep, Unchanged' }),
      existing({ id: 'e2', sisUserId: '2', displayName: 'Change, Section' }),
      existing({
        id: 'e3',
        sisUserId: '3',
        displayName: 'Dropped, Registered',
        claimedByUserId: 'u3',
        claimedByLogin: 'dropped-dev',
        repoCount: 2,
      }),
      existing({ id: 'e4', sisUserId: '4', displayName: 'Dropped, Unregistered' }),
      existing({
        id: 'e5',
        sisUserId: '5',
        displayName: 'Returning, Student',
        removedAt: new Date('2026-07-01'),
      }),
    ]

    const csv = [
      parsed({ sisUserId: '1', displayName: 'Keep, Unchanged' }),
      parsed({ sisUserId: '2', displayName: 'Change, Section', section: 'COP4331-0002' }),
      parsed({ sisUserId: '5', displayName: 'Returning, Student' }),
      parsed({ sisUserId: '6', displayName: 'Brand, New' }),
    ]

    const diff = diffRoster(csv, existingRoster)

    expect(diff.unchanged.map((u) => u.existing.id)).toEqual(['e1'])
    expect(diff.updated.map((u) => u.existing.id)).toEqual(['e2'])
    expect(diff.restored.map((r) => r.existing.id)).toEqual(['e5'])
    expect(diff.added.map((a) => a.sisUserId)).toEqual(['6'])
    expect(diff.removed.map((r) => r.id).sort()).toEqual(['e3', 'e4'])
    // Only the registered dropout needs a decision from the instructor.
    expect(diff.destructive.map((d) => d.entry.id)).toEqual(['e3'])
  })
})
