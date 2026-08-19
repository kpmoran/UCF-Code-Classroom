import { describe, expect, it } from 'vitest'

import { belongsToOrg } from './operations/orgs'

/**
 * The multi-tenancy gate, at the level where the decision is made.
 *
 * Worth testing directly: the installation list is App-wide, so this predicate is the
 * only thing standing between a faculty member and creating a classroom in a
 * colleague's organization — where assignments would then generate repositories using
 * an installation token holding Administration: write.
 */
describe('belongsToOrg', () => {
  it('admits an organization owner', () => {
    expect(belongsToOrg({ isOwner: true, role: 'admin' })).toBe(true)
  })

  it('admits a plain member, who is not an owner', () => {
    // Everything except group assignments works for a member, so excluding them would
    // be a bigger break than the hole being closed.
    expect(
      belongsToOrg({ isOwner: false, role: 'member', reason: 'not an Owner' }),
    ).toBe(true)
  })

  it('admits someone whose invitation is still pending', () => {
    // Same reason the ownership check warns rather than blocks: an instructor waiting on
    // a promotion or an invitation should not be stranded.
    expect(
      belongsToOrg({ isOwner: false, role: 'member', reason: 'membership is still pending' }),
    ).toBe(true)
  })

  it('refuses someone who is not a member at all', () => {
    // role === null is the 404 from GitHub, and the case the gate exists for.
    expect(
      belongsToOrg({ isOwner: false, role: null, reason: 'not a member of that org' }),
    ).toBe(false)
  })

  it('treats role as the deciding field, not the reason text', () => {
    // The reason is prose meant for a person and will be reworded; the decision must not
    // depend on it.
    expect(belongsToOrg({ isOwner: false, role: null, reason: 'anything at all' })).toBe(false)
    expect(belongsToOrg({ isOwner: false, role: 'billing_manager', reason: 'x' })).toBe(true)
  })
})
