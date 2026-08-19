/**
 * Map a GitHub profile onto our User model.
 *
 * Extracted from the provider definitions so it can be unit tested. It was inline
 * and duplicated across both providers, and it carried a bug that no test could
 * reach: the returned object had no `id`.
 *
 * That field is not decoration. @auth/core does:
 *
 *     providerAccountId: userFromProfile.id ?? crypto.randomUUID()
 *
 * so omitting it stores a **random UUID** as the account link. The first sign-in
 * succeeds and writes it; every later sign-in generates a different UUID, fails to
 * find the account, tries to create a second user with the same githubId, and dies
 * on the unique constraint as an opaque AdapterError. In other words: sign-in works
 * exactly once per account, then never again.
 *
 * The end-to-end suite could not catch it, because signing in there is done by
 * seeding a session row — the GitHub consent screen cannot be automated. So the real
 * OAuth callback never ran until production. Hence this function, and the tests
 * beside it.
 *
 * Note the Prisma adapter does `createUser: ({ id, ...data })` — it strips `id`
 * before insert, so returning one does not become the primary key. The database
 * still issues its own cuid.
 */

export type GitHubProfile = {
  id: number | string
  login: string
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}

export type MappedUser = {
  id: string
  name: string | null
  email: string | null
  image: string | null
  githubId: string
  githubLogin: string
}

export function githubProfileToUser(profile: GitHubProfile): MappedUser {
  return {
    // Stable across sign-ins, and the value @auth/core stores as
    // providerAccountId. This is the whole point.
    id: String(profile.id),
    // GitHub allows an empty display name; the login always exists.
    name: profile.name ?? profile.login,
    // Null rather than undefined: a GitHub App user token cannot read private
    // addresses, so this is routinely absent and the column is nullable.
    email: profile.email ?? null,
    image: profile.avatar_url ?? null,
    githubId: String(profile.id),
    githubLogin: profile.login,
  }
}
