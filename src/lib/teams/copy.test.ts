import { describe, expect, it } from 'vitest'

import { planTeamCopy, type SourceTeam } from './copy'
import type { TeamConstraints } from './rules'

const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const unlimited: TeamConstraints = {
  maxTeams: null,
  maxTeamSize: null,
  teamNamingMode: 'STUDENT_CHOSEN',
}

const knights: SourceTeam = {
  name: 'Knights',
  members: [
    { userId: 'ava', role: 'LEADER' },
    { userId: 'ben', role: 'MEMBER' },
  ],
}
const rooks: SourceTeam = {
  name: 'Rooks',
  members: [{ userId: 'cal', role: 'LEADER' }],
}

const everyone = new Set(['ava', 'ben', 'cal'])

function plan(overrides: Partial<Parameters<typeof planTeamCopy>[0]> = {}) {
  return planTeamCopy({
    source: [knights, rooks],
    existingNames: [],
    constraints: unlimited,
    eligible: everyone,
    slugify,
    ...overrides,
  })
}

describe('planTeamCopy', () => {
  it('copies every team with its members and their roles', () => {
    const result = plan()
    expect(result).toEqual({
      ok: true,
      skipped: [],
      teams: [
        { name: 'Knights', members: knights.members },
        { name: 'Rooks', members: rooks.members },
      ],
    })
  })

  it('refuses when there is nothing to copy', () => {
    const result = plan({ source: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no teams to copy/)
  })

  it('refuses to copy into an assignment that already has teams', () => {
    const result = plan({ existingNames: ['Pawns'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/already has teams/)
  })

  it('refuses when the source has more teams than the target allows', () => {
    const result = plan({ constraints: { ...unlimited, maxTeams: 1 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/2 teams.*at most 1/)
  })

  it('allows exactly the maximum number of teams', () => {
    expect(plan({ constraints: { ...unlimited, maxTeams: 2 } }).ok).toBe(true)
  })

  it('refuses when a team is larger than the target allows, naming the team', () => {
    const result = plan({ constraints: { ...unlimited, maxTeamSize: 1 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/“Knights” has 2 members.*at most 1/)
  })

  it('skips students who are no longer on the roster and says which team they were on', () => {
    const result = plan({ eligible: new Set(['ava', 'cal']) })
    expect(result).toEqual({
      ok: true,
      skipped: [{ userId: 'ben', team: 'Knights' }],
      teams: [
        { name: 'Knights', members: [{ userId: 'ava', role: 'LEADER' }] },
        { name: 'Rooks', members: rooks.members },
      ],
    })
  })

  it('measures team size after skipping, so a departed student does not block the copy', () => {
    const result = plan({
      eligible: new Set(['ava', 'cal']),
      constraints: { ...unlimited, maxTeamSize: 1 },
    })
    expect(result.ok).toBe(true)
  })

  it('still creates a team whose members have all left, rather than losing it', () => {
    const result = plan({ eligible: new Set(['ava', 'ben']) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.teams.map((t) => t.name)).toEqual(['Knights', 'Rooks'])
      expect(result.teams[1]!.members).toEqual([])
      expect(result.skipped).toEqual([{ userId: 'cal', team: 'Rooks' }])
    }
  })

  it('refuses two source teams that would share a GitHub slug', () => {
    const result = plan({
      source: [
        { name: 'The Knights', members: [] },
        { name: 'the-knights', members: [] },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/share the GitHub name “the-knights”/)
  })
})
