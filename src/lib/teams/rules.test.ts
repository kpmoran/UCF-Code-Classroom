import { describe, expect, it } from 'vitest'

import { slugifyTeamName } from '@/lib/github/repoName'

import {
  canCreateTeam,
  canJoinTeam,
  canLeaveTeam,
  canProvisionTeam,
  describeConstraints,
  validateTeamName,
  type TeamConstraints,
  type TeamSnapshot,
} from './rules'

const OPEN: TeamConstraints = {
  maxTeams: null,
  maxTeamSize: null,
  teamNamingMode: 'STUDENT_CHOSEN',
}

function team(over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return { id: 't1', name: 'The Knights', memberCount: 1, hasRepo: false, ...over }
}

describe('validateTeamName', () => {
  it('accepts a reasonable name', () => {
    expect(validateTeamName('The Knights', [], slugifyTeamName).allowed).toBe(true)
  })

  it('rejects names that are too short or too long', () => {
    expect(validateTeamName('A', [], slugifyTeamName).allowed).toBe(false)
    expect(validateTeamName('x'.repeat(61), [], slugifyTeamName).allowed).toBe(false)
  })

  it('rejects a name with nothing GitHub can use', () => {
    // Becomes an empty slug, so two such teams would collide on GitHub.
    const result = validateTeamName('学生チーム', [], slugifyTeamName)
    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toMatch(/no letters or numbers/)
  })

  it('rejects an exact duplicate with an invitation to join it', () => {
    const result = validateTeamName('The Knights', ['The Knights'], slugifyTeamName)
    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toMatch(/already exists\. Join it/)
  })

  it('rejects a name that only differs by punctuation or case', () => {
    // "the-knights" and "The Knights!" slug identically; allowing both would
    // create two app teams fighting over one GitHub team.
    for (const candidate of ['the-knights', 'THE KNIGHTS', 'The  Knights!', 'the.knights']) {
      const result = validateTeamName(candidate, ['The Knights'], slugifyTeamName)
      expect(result.allowed, `${candidate} should be rejected`).toBe(false)
      if (!result.allowed) expect(result.reason).toMatch(/too close|already exists/)
    }
  })

  it('allows a genuinely different name', () => {
    expect(validateTeamName('The Squires', ['The Knights'], slugifyTeamName).allowed).toBe(true)
  })

  it('trims surrounding whitespace before judging length', () => {
    expect(validateTeamName('   ab   ', [], slugifyTeamName).allowed).toBe(true)
    expect(validateTeamName('   a   ', [], slugifyTeamName).allowed).toBe(false)
  })
})

describe('canCreateTeam', () => {
  it('allows a student when naming is student-chosen', () => {
    expect(canCreateTeam(OPEN, 0, 'STUDENT').allowed).toBe(true)
  })

  it('refuses a student when the instructor assigns teams', () => {
    const constraints = { ...OPEN, teamNamingMode: 'INSTRUCTOR_ASSIGNED' as const }
    const result = canCreateTeam(constraints, 0, 'STUDENT')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/instructor assigns teams/)
  })

  it('still allows staff when the instructor assigns teams', () => {
    const constraints = { ...OPEN, teamNamingMode: 'INSTRUCTOR_ASSIGNED' as const }
    expect(canCreateTeam(constraints, 5, 'STAFF').allowed).toBe(true)
  })

  it('enforces the team cap', () => {
    const constraints = { ...OPEN, maxTeams: 3 }
    expect(canCreateTeam(constraints, 2, 'STUDENT').allowed).toBe(true)

    const result = canCreateTeam(constraints, 3, 'STUDENT')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/at most 3 teams/)
  })
})

describe('canJoinTeam', () => {
  it('allows joining when unaffiliated and there is room', () => {
    expect(canJoinTeam(OPEN, team(), null).allowed).toBe(true)
  })

  it('says so when the student is already on that team', () => {
    const t = team()
    const result = canJoinTeam(OPEN, t, t)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/already on The Knights/)
  })

  it('refuses a second team and names the current one', () => {
    const result = canJoinTeam(OPEN, team({ id: 't2', name: 'The Squires' }), team())
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/already on The Knights/)
  })

  it('enforces the size cap', () => {
    const constraints = { ...OPEN, maxTeamSize: 4 }
    expect(canJoinTeam(constraints, team({ memberCount: 3 }), null).allowed).toBe(true)

    const result = canJoinTeam(constraints, team({ memberCount: 4 }), null)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/is full \(4 members\)/)
  })
})

describe('canLeaveTeam', () => {
  it('allows leaving before a repository exists', () => {
    expect(canLeaveTeam(team({ hasRepo: false }), 'STUDENT').allowed).toBe(true)
  })

  it('refuses a student leaving once the repository exists', () => {
    // Their commits are already in it; silently revoking access would look like
    // data loss to them and a missing contribution to the instructor.
    const result = canLeaveTeam(team({ hasRepo: true }), 'STUDENT')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/Ask your instructor to move you/)
  })

  it('still allows staff to move someone after the repository exists', () => {
    expect(canLeaveTeam(team({ hasRepo: true }), 'STAFF').allowed).toBe(true)
  })
})

describe('canProvisionTeam', () => {
  it('allows a team of one', () => {
    // Requiring a full team would block the class on its slowest members.
    expect(canProvisionTeam(team({ memberCount: 1 })).allowed).toBe(true)
  })

  it('refuses an empty team', () => {
    expect(canProvisionTeam(team({ memberCount: 0 })).allowed).toBe(false)
  })

  it('refuses a team that already has a repository', () => {
    const result = canProvisionTeam(team({ hasRepo: true }))
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/already has a repository/)
  })
})

describe('describeConstraints', () => {
  it('describes both limits', () => {
    expect(describeConstraints({ ...OPEN, maxTeams: 10, maxTeamSize: 4 })).toBe(
      'at most 10 teams, up to 4 members per team.',
    )
  })

  it('describes a single limit', () => {
    expect(describeConstraints({ ...OPEN, maxTeamSize: 4 })).toBe('up to 4 members per team.')
  })

  it('says when there are no limits', () => {
    expect(describeConstraints(OPEN)).toBe('No limit on teams or team size.')
  })
})
