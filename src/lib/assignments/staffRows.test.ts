import { describe, expect, it } from 'vitest'

import { byStudent, matchesQuery, studentRowMatches, type RowLike } from './staffRows'

const ava = { userId: 'u1', name: 'Knight, Ava', githubLogin: 'avak', membershipState: 'active' }
const ben = { userId: 'u2', name: 'Baker, Ben', githubLogin: null, membershipState: 'pending' }
const cal = { userId: 'u3', name: 'Cruz, Cal', githubLogin: 'calc', membershipState: 'active' }

const knights: RowLike = {
  id: 'r1',
  who: 'Team Knights',
  githubLogin: null,
  fullName: 'org/hw1-knights',
  members: [ava, ben],
}
const rooks: RowLike = {
  id: 'r2',
  who: 'Team Rooks',
  githubLogin: null,
  fullName: 'org/hw1-rooks',
  members: [cal],
}
const empty: RowLike = {
  id: 'r3',
  who: 'Team Nobody',
  githubLogin: null,
  fullName: null,
  members: [],
}

describe('byStudent', () => {
  it('expands each team into one row per member, sorted by student name', () => {
    const rows = byStudent([knights, rooks])
    expect(rows.map((r) => r.member?.name)).toEqual(['Baker, Ben', 'Cruz, Cal', 'Knight, Ava'])
    expect(rows.map((r) => r.repo.id)).toEqual(['r1', 'r2', 'r1'])
  })

  it('keeps a memberless team visible as a single row', () => {
    const rows = byStudent([empty])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.member).toBeNull()
    expect(rows[0]!.key).toBe('r3')
  })

  it('gives every row a distinct key', () => {
    const keys = byStudent([knights, rooks, empty]).map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('sorts case-insensitively and places a memberless team by its own name', () => {
    const rows = byStudent([empty, knights])
    expect(rows.map((r) => r.member?.name ?? r.repo.who)).toEqual([
      'Baker, Ben',
      'Knight, Ava',
      'Team Nobody',
    ])
  })
})

describe('matchesQuery', () => {
  it('matches a team by any of its members', () => {
    expect(matchesQuery(knights, 'ava')).toBe(true)
    expect(matchesQuery(knights, 'AVAK')).toBe(true)
    expect(matchesQuery(rooks, 'ava')).toBe(false)
  })

  it('still matches the team name and repository', () => {
    expect(matchesQuery(knights, 'knights')).toBe(true)
    expect(matchesQuery(knights, 'hw1-kni')).toBe(true)
  })

  it('treats a blank query as matching everything', () => {
    expect(matchesQuery(empty, '   ')).toBe(true)
  })

  it('ignores members without a login rather than matching "null"', () => {
    expect(matchesQuery(knights, 'null')).toBe(false)
  })
})

describe('studentRowMatches', () => {
  it('matches only the member on the row, not their teammates', () => {
    const [benRow, , avaRow] = byStudent([knights, rooks])
    expect(studentRowMatches(avaRow!, 'ava')).toBe(true)
    expect(studentRowMatches(benRow!, 'ava')).toBe(false)
  })

  it('matches the team name and repository on every member row', () => {
    const rows = byStudent([knights])
    expect(rows.every((r) => studentRowMatches(r, 'knights'))).toBe(true)
    expect(rows.every((r) => studentRowMatches(r, 'org/hw1'))).toBe(true)
  })

  it('matches a memberless team by its name', () => {
    const [row] = byStudent([empty])
    expect(studentRowMatches(row!, 'nobody')).toBe(true)
    expect(studentRowMatches(row!, 'ava')).toBe(false)
  })
})
