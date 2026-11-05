import { describe, expect, it } from 'vitest'

import {
  ORG_INVITATION_LIFETIME_MS,
  decideOrgRemoval,
  effectiveOrgState,
  orgAccessProblem,
  studentTeamName,
} from './orgRules'

describe('studentTeamName', () => {
  it('names the team for the course and term', () => {
    expect(studentTeamName({ name: 'Intro', courseCode: 'COP3502', term: 'Spring 2027' })).toBe(
      'COP3502-Spring 2027-students',
    )
  })

  it('falls back to the classroom name rather than a bare suffix', () => {
    expect(studentTeamName({ name: 'Intro', courseCode: null, term: null })).toBe('Intro-students')
  })
})

describe('orgAccessProblem', () => {
  it('accepts "No permission"', () => {
    expect(orgAccessProblem({ baseRepositoryPermission: 'none' })).toBeNull()
  })

  it('does not refuse when the setting could not be read', () => {
    expect(orgAccessProblem({ baseRepositoryPermission: null })).toBeNull()
  })

  it('refuses read, naming the privacy problem only', () => {
    const problem = orgAccessProblem({ baseRepositoryPermission: 'read' })
    expect(problem).toContain('read every other student')
    expect(problem).not.toContain('deadline locks')
  })

  it('refuses write, naming the broken deadline locks too', () => {
    expect(orgAccessProblem({ baseRepositoryPermission: 'write' })).toContain(
      'deadline locks would not hold',
    )
    expect(orgAccessProblem({ baseRepositoryPermission: 'admin' })).toContain(
      'deadline locks would not hold',
    )
  })
})

describe('effectiveOrgState', () => {
  const now = new Date('2027-01-20T12:00:00Z')

  it('keeps a recent invitation pending', () => {
    const invitedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    expect(effectiveOrgState('pending', invitedAt, now)).toBe('pending')
  })

  it('reports an invitation past its lifetime as expired', () => {
    const invitedAt = new Date(now.getTime() - ORG_INVITATION_LIFETIME_MS - 1000)
    expect(effectiveOrgState('pending', invitedAt, now)).toBe('expired')
  })

  it('passes other states through, and treats unknown ones as not invited', () => {
    expect(effectiveOrgState('active', null, now)).toBe('active')
    expect(effectiveOrgState('failed', null, now)).toBe('failed')
    expect(effectiveOrgState(null, null, now)).toBeNull()
    expect(effectiveOrgState('something-else', null, now)).toBeNull()
  })
})

describe('decideOrgRemoval', () => {
  const eligible = {
    joinedViaClassroom: true,
    orgRole: 'member',
    staffInAnotherClassroom: false,
    studentInAnotherActiveClassroom: false,
  }

  it('removes a student this classroom made a member, and nobody else needs', () => {
    expect(decideOrgRemoval(eligible)).toEqual({ remove: true })
  })

  it('never removes someone who was already a member', () => {
    expect(decideOrgRemoval({ ...eligible, joinedViaClassroom: false }).remove).toBe(false)
  })

  it('never removes an owner', () => {
    expect(decideOrgRemoval({ ...eligible, orgRole: 'admin' }).remove).toBe(false)
  })

  it('keeps someone another classroom still needs', () => {
    expect(decideOrgRemoval({ ...eligible, staffInAnotherClassroom: true }).remove).toBe(false)
    expect(decideOrgRemoval({ ...eligible, studentInAnotherActiveClassroom: true }).remove).toBe(
      false,
    )
  })
})
