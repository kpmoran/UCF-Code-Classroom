import { describe, expect, it } from 'vitest'

import {
  buildRepoName,
  buildTeamRepoName,
  dedupeRepoName,
  sanitizeRepoSegment,
  slugifyTeamName,
} from './repoName'

describe('sanitizeRepoSegment', () => {
  it('lowercases and keeps permitted characters', () => {
    expect(sanitizeRepoSegment('HW1_final.v2')).toBe('hw1_final.v2')
  })

  it('replaces runs of disallowed characters with a single hyphen', () => {
    expect(sanitizeRepoSegment('team alpha / beta')).toBe('team-alpha-beta')
  })

  it('strips accents rather than the whole letter', () => {
    // "Órla" must not become "rla" — a student's name should still be
    // recognizable in their repo name.
    expect(sanitizeRepoSegment('Órla')).toBe('orla')
    expect(sanitizeRepoSegment('Müller')).toBe('muller')
  })

  it('trims leading and trailing separators', () => {
    expect(sanitizeRepoSegment('--team--')).toBe('team')
    expect(sanitizeRepoSegment('.hidden.')).toBe('hidden')
  })

  it('returns empty when nothing permitted remains', () => {
    expect(sanitizeRepoSegment('学生')).toBe('')
    expect(sanitizeRepoSegment('!!!')).toBe('')
  })
})

describe('buildRepoName', () => {
  it('joins prefix and identifier', () => {
    expect(buildRepoName({ prefix: 'hw1', identifier: 'nid100000' })).toBe('hw1-nid100000')
  })

  it('sanitizes both segments', () => {
    expect(buildRepoName({ prefix: 'HW 1', identifier: 'Doe, Jane' })).toBe('hw-1-doe-jane')
  })

  it('throws rather than producing a colliding stub', () => {
    // Two students with only non-Latin names would both get "hw1-", silently
    // sharing one repository. Failing loudly forces the GitHub-login fallback.
    expect(() => buildRepoName({ prefix: 'hw1', identifier: '学生' })).toThrow(
      /contains no characters GitHub permits/,
    )
  })

  it('truncates the identifier, not the prefix, at 100 characters', () => {
    const name = buildRepoName({ prefix: 'project-milestone-1', identifier: 'x'.repeat(200) })
    expect(name.length).toBe(100)
    expect(name.startsWith('project-milestone-1-')).toBe(true)
  })
})

describe('dedupeRepoName', () => {
  it('returns the base name when free', () => {
    expect(dedupeRepoName('hw1-abc', new Set())).toBe('hw1-abc')
  })

  it('appends an incrementing suffix', () => {
    expect(dedupeRepoName('hw1-abc', new Set(['hw1-abc']))).toBe('hw1-abc-2')
    expect(dedupeRepoName('hw1-abc', new Set(['hw1-abc', 'hw1-abc-2']))).toBe('hw1-abc-3')
  })

  it('keeps the result within the length limit', () => {
    const base = 'a'.repeat(100)
    const result = dedupeRepoName(base, new Set([base]))
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result.endsWith('-2')).toBe(true)
  })
})

describe('buildTeamRepoName', () => {
  it('uses the team name as the identifier', () => {
    expect(buildTeamRepoName('project-m1', 'The Knights')).toBe('project-m1-the-knights')
  })
})

describe('slugifyTeamName', () => {
  // Team provisioning looks a team up by slug before creating it, so this must
  // match GitHub's own derivation or every retry creates a duplicate team.
  it('matches GitHub-style slugs', () => {
    expect(slugifyTeamName('The Knights')).toBe('the-knights')
    expect(slugifyTeamName('Team #4')).toBe('team-4')
    expect(slugifyTeamName('a  b')).toBe('a-b')
  })

  it('drops underscores and periods, unlike repository names', () => {
    // GitHub team slugs permit only alphanumerics and hyphens.
    expect(slugifyTeamName('team_alpha.v2')).toBe('team-alpha-v2')
  })

  it('strips accents and trims separators', () => {
    expect(slugifyTeamName('Équipe Alpha')).toBe('equipe-alpha')
    expect(slugifyTeamName('--edge--')).toBe('edge')
  })
})
