import { describe, expect, it } from 'vitest'

import { githubProfileToUser } from './profile'

const BASE = {
  id: 7926838,
  login: 'kpmoran',
  name: 'Kevin Moran',
  email: 'kpmoran@example.edu',
  avatar_url: 'https://avatars.githubusercontent.com/u/7926838',
}

describe('githubProfileToUser', () => {
  it('returns an id, because @auth/core stores it as providerAccountId', () => {
    // The bug this exists to prevent. Without `id`, @auth/core falls back to
    // `crypto.randomUUID()` — a different value every sign-in — so the account link
    // written on the first sign-in can never be found again. Sign-in then works
    // exactly once per account and fails forever after with a unique-constraint
    // violation on githubId, surfaced as an opaque AdapterError.
    const user = githubProfileToUser(BASE)
    expect(user.id).toBe('7926838')
  })

  it('derives the id from the GitHub account id, not the login', () => {
    // Logins are renameable; the numeric id is not. Keying the account link to the
    // login would silently unlink anyone who renames their GitHub account.
    const renamed = githubProfileToUser({ ...BASE, login: 'kmoran-ucf' })
    expect(renamed.id).toBe('7926838')
    expect(renamed.githubLogin).toBe('kmoran-ucf')
  })

  it('is stable across repeated calls with the same profile', () => {
    const a = githubProfileToUser(BASE)
    const b = githubProfileToUser(BASE)
    expect(a.id).toBe(b.id)
    expect(a).toEqual(b)
  })

  it('stringifies a numeric id, since providerAccountId is a string column', () => {
    expect(githubProfileToUser({ ...BASE, id: 12345 }).id).toBe('12345')
    expect(githubProfileToUser({ ...BASE, id: '12345' }).id).toBe('12345')
  })

  it('falls back to the login when GitHub has no display name', () => {
    expect(githubProfileToUser({ ...BASE, name: null }).name).toBe('kpmoran')
    expect(githubProfileToUser({ ...BASE, name: undefined }).name).toBe('kpmoran')
  })

  it('maps a missing email to null rather than undefined', () => {
    // A GitHub App user token cannot read private addresses, so this is the common
    // case, not an edge one. undefined would be dropped by stripUndefined in the
    // adapter — harmless here, but null says "we looked and there is none".
    expect(githubProfileToUser({ ...BASE, email: null }).email).toBeNull()
    expect(githubProfileToUser({ ...BASE, email: undefined }).email).toBeNull()
  })

  it('maps a missing avatar to null', () => {
    expect(githubProfileToUser({ ...BASE, avatar_url: null }).image).toBeNull()
  })

  it('carries githubId and githubLogin through for the User model', () => {
    const user = githubProfileToUser(BASE)
    expect(user.githubId).toBe('7926838')
    expect(user.githubLogin).toBe('kpmoran')
  })

  it('keeps githubId a string, because a BigInt breaks session serialization', () => {
    // Auth.js JSON-serializes the session and the adapter passes this object into
    // it, so a non-serializable type here fails every sign-in with an error naming
    // the type and not the field.
    const user = githubProfileToUser(BASE)
    expect(typeof user.githubId).toBe('string')
    expect(() => JSON.stringify(user)).not.toThrow()
  })
})
