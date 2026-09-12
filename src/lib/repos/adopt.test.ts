import { describe, expect, it } from 'vitest'

import { canAdoptRepo, type AdoptInput } from './adopt'

const BASE: AdoptInput = {
  repoSource: 'EXISTING',
  orgLogin: 'ucf-code-connect',
  ref: { owner: 'ucf-code-connect', repo: 'cen5016-team-atlas' },
  conflictsWith: null,
}

describe('canAdoptRepo', () => {
  it('accepts a repository in the classroom organization', () => {
    expect(canAdoptRepo(BASE).allowed).toBe(true)
  })

  it('matches the organization case-insensitively', () => {
    const result = canAdoptRepo({ ...BASE, ref: { owner: 'UCF-Code-Connect', repo: 'x' } })
    expect(result.allowed).toBe(true)
  })

  it('refuses when the assignment creates its own repositories', () => {
    const result = canAdoptRepo({ ...BASE, repoSource: 'CREATE' })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/creates its own repositories/)
  })

  it('refuses an unreadable reference', () => {
    const result = canAdoptRepo({ ...BASE, ref: null })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/owner\/name/)
  })

  /*
   * The case that would otherwise fail late and confusingly: linking resolves, and
   * then every GitHub write in provisioning 404s against an organization the
   * installation has no token for.
   */
  it('refuses a repository outside the organization, naming both', () => {
    const result = canAdoptRepo({
      ...BASE,
      ref: { owner: 'some-student', repo: 'cen5016-project' },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('some-student/cen5016-project')
      expect(result.reason).toContain('ucf-code-connect')
    }
  })

  it('refuses a conflict when the caller supplies one, naming the holder', () => {
    const result = canAdoptRepo({ ...BASE, conflictsWith: 'Team Borealis' })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain('Team Borealis')
  })

  /*
   * Sharing is the individual-assignment case: several students assigned one
   * repository is deliberate, so those callers pass no conflict and this must allow
   * it rather than having an opinion of its own.
   */
  it('allows the same repository when no conflict is supplied', () => {
    expect(canAdoptRepo({ ...BASE, conflictsWith: null }).allowed).toBe(true)
  })

  it('reports the assignment mode before anything else', () => {
    const result = canAdoptRepo({
      ...BASE,
      repoSource: 'CREATE',
      ref: { owner: 'elsewhere', repo: 'x' },
      conflictsWith: 'Team Borealis',
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/creates its own repositories/)
  })
})
