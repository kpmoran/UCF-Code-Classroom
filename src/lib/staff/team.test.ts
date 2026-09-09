import { describe, expect, it } from 'vitest'

import { slugifyTeamName } from '@/lib/github/repoName'

import { staffTeamMustAvoidRepo, staffTeamName } from './team'

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

describe('staffTeamMustAvoidRepo', () => {
  it('leaves an ordinary student repository alone', () => {
    expect(
      staffTeamMustAvoidRepo({
        participantUserIds: ['student-1'],
        staffUserIds: ['instructor-1', 'ta-1'],
      }),
    ).toBe(false)
  })

  it("keeps the team off a TA's own submission", () => {
    /*
     * The case that matters. Accepting an assignment needs a claimed roster entry and
     * any classroom role, so a TA can hold a real repository — and the deadline lock
     * works by lowering their *direct* collaborator permission to pull. GitHub takes
     * the highest permission across all sources, so a team grant of push would
     * override it and the app would report a lock that does not hold.
     */
    expect(
      staffTeamMustAvoidRepo({
        participantUserIds: ['ta-1'],
        staffUserIds: ['instructor-1', 'ta-1'],
      }),
    ).toBe(true)
  })

  it('catches a staff member hidden among a team repository’s members', () => {
    // Group assignments share one repository, so one staff member anywhere in the
    // team is enough to break the lock for that repository.
    expect(
      staffTeamMustAvoidRepo({
        participantUserIds: ['student-1', 'student-2', 'ta-1'],
        staffUserIds: ['ta-1'],
      }),
    ).toBe(true)
  })

  it('does not trip on an empty classroom or an unclaimed repository', () => {
    expect(
      staffTeamMustAvoidRepo({ participantUserIds: [], staffUserIds: ['ta-1'] }),
    ).toBe(false)
    expect(
      staffTeamMustAvoidRepo({ participantUserIds: ['student-1'], staffUserIds: [] }),
    ).toBe(false)
  })
})
