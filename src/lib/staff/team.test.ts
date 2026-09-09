import { describe, expect, it } from 'vitest'

import { slugifyTeamName } from '@/lib/github/repoName'

import { staffTeamName } from './team'

describe('staffTeamName', () => {
  it('names the team for the course and term', () => {
    expect(
      staffTeamName({ name: 'Software Engineering', courseCode: 'CEN-5016', term: 'Fall 2026' }),
    ).toBe('CEN-5016-Fall 2026-staff')
  })

  it('uses whichever of course code and term is set', () => {
    expect(staffTeamName({ name: 'Anything', courseCode: 'CEN-5016', term: null })).toBe(
      'CEN-5016-staff',
    )
    expect(staffTeamName({ name: 'Anything', courseCode: null, term: 'Fall 2026' })).toBe(
      'Fall 2026-staff',
    )
  })

  it('falls back to the classroom name rather than producing "-staff"', () => {
    // Both fields are nullable. An empty label would give every such classroom in an
    // organization a team called "-staff" — and createTeam returns an existing team
    // rather than failing, so two unrelated courses would silently share one team and
    // each course's TAs would get access to the other's repositories.
    expect(staffTeamName({ name: 'Intro to Testing', courseCode: null, term: null })).toBe(
      'Intro to Testing-staff',
    )
  })

  it('survives slugification into something distinct', () => {
    const a = slugifyTeamName(
      staffTeamName({ name: 'x', courseCode: 'CEN-5016', term: 'Fall 2026' }),
    )
    const b = slugifyTeamName(
      staffTeamName({ name: 'x', courseCode: 'CEN-5016', term: 'Spring 2027' }),
    )
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z0-9-]+$/)
  })
})
