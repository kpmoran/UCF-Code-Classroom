import { PrismaAdapter } from '@auth/prisma-adapter'
import NextAuth, { type NextAuthConfig } from 'next-auth'
import GitHub from 'next-auth/providers/github'

import { githubProfileToUser } from './profile'
import { OWNER_PROVIDER_ID } from './providers'
import { encryptSecret } from '@/lib/crypto'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

/**
 * Authentication.
 *
 * Two GitHub providers, deliberately:
 *
 *   `github`       Everyone. Requests only `read:user` and `user:email` — the
 *                  minimum needed to identify a student and match them to a
 *                  roster entry. Students never grant more than this.
 *
 *   `github-owner` Instructors only, linked as a second account on an existing
 *                  session. Marks which user is a classroom's designated
 *                  organization owner, whose token acts as the *fallback* for
 *                  team operations. Group assignments do not depend on it: the
 *                  App installation token handles teams (verified against a live
 *                  org — see operations/teams.ts).
 *
 * The stored token is encrypted before it reaches the database (see the
 * `linkAccount` / `signIn` handling below).
 */

export { OWNER_PROVIDER_ID } from './providers'

/**
 * Note on scopes: a **GitHub App** user access token does not use OAuth scopes
 * at all. GitHub ignores the `scope` parameter and always reports an empty
 * scope string. What such a token may do is the *intersection* of the App's
 * installed permissions and the signing-in user's own permissions.
 *
 * That is exactly why this works: with `Organization members: write` granted to
 * the App, a token minted for a user who is an organization **owner** can invite
 * non-members to teams, while the same token for a student could not. The
 * authorization therefore rests on org ownership, which is verified explicitly
 * via `checkOrgOwnership()` rather than inferred from a scope string.
 */

const adapter = PrismaAdapter(db)

export const authConfig = {
  adapter,
  /**
   * Trust the incoming Host header to build callback and redirect URLs.
   *
   * Auth.js infers this when NODE_ENV is not 'production', which is why every
   * development run and all 50 end-to-end tests pass without it — and why the
   * omission only appears once the app runs in a production container, where
   * `/api/auth/session` answers 500 with UntrustedHost and no one can sign in.
   *
   * Required for any self-hosted deployment behind a reverse proxy, which is
   * every deployment of this app. The header is only as trustworthy as the proxy
   * in front of it, so terminate TLS and set Host there rather than letting an
   * arbitrary one through; APP_URL remains the canonical origin the app uses for
   * links it generates itself.
   */
  trustHost: true,
  session: { strategy: 'database' },
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  providers: [
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
      authorization: { params: { scope: 'read:user user:email' } },
      profile: githubProfileToUser,
    }),
    GitHub({
      id: OWNER_PROVIDER_ID,
      name: 'GitHub (organization owner)',
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
      // No `scope` param: see the note above — GitHub App user tokens ignore it.
      // This provider exists to mark *which* signed-in user is the designated
      // organization owner for a classroom, so a TA signing in normally is never
      // mistaken for one, and so the token used by background jobs is explicit.
      //
      // The instructor is already signed in via `github` when they link this,
      // and it is the same GitHub identity, so account linking is expected
      // rather than an attack. Both providers are the same trusted App.
      allowDangerousEmailAccountLinking: true,
      profile: githubProfileToUser,
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      const row = user as {
        id: string
        name?: string | null
        email?: string | null
        image?: string | null
        githubLogin?: string | null
        isSiteAdmin?: boolean
        isFaculty?: boolean
      } | null

      /**
       * Return a freshly built session rather than the one passed in.
       *
       * Two reasons, both load-bearing:
       *
       * 1. Under the database strategy the incoming `session` is an
       *    `AdapterSession`, which carries **`sessionToken`** — the bearer
       *    credential itself — plus `userId`. Returning that object publishes the
       *    session token in the `/api/auth/session` JSON body, where any script
       *    on the page or any logged response could capture it. Only `user` and
       *    `expires` belong in the response.
       *
       * 2. Auth.js JSON-serializes whatever comes back, so an explicit whitelist
       *    prevents a future non-serializable column on the User model (a
       *    BigInt, a Decimal) from breaking sign-in for everyone. That failure
       *    reports the offending *type* and not the field, which makes it
       *    disproportionately slow to diagnose.
       */
      // `session.expires` is typed as `Date & string` here — the intersection of
      // the database and JWT callback shapes — so it must be widened before it
      // can be narrowed. It is a Date under the database strategy.
      const expires: unknown = session.expires

      return {
        expires: expires instanceof Date ? expires.toISOString() : String(expires),
        user: {
          id: row?.id ?? '',
          name: row?.name ?? null,
          email: row?.email ?? null,
          image: row?.image ?? null,
          githubLogin: row?.githubLogin ?? null,
          isSiteAdmin: row?.isSiteAdmin ?? false,
          isFaculty: row?.isFaculty ?? false,
        },
      }
    },
  },
  events: {
    /**
     * Encrypt the elevated token at rest and flag the account as an owner
     * token. Auth.js writes the raw `access_token` via the adapter, so this
     * runs immediately afterwards to replace it.
     *
     * The plaintext token exists in the accounts row only between these two
     * statements. That is a narrow but real window; it is accepted because
     * Auth.js offers no hook that intercepts the write itself.
     */
    async linkAccount({ account }) {
      await persistTokenSecurely(account.provider, account.providerAccountId)
    },
    async signIn({ account }) {
      if (account) {
        await persistTokenSecurely(account.provider, account.providerAccountId)
      }
    },
  },
} satisfies NextAuthConfig

async function persistTokenSecurely(provider: string, providerAccountId: string) {
  const isOwner = provider === OWNER_PROVIDER_ID

  const row = await db.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { id: true, access_token: true },
  })
  if (!row?.access_token) return

  // Already encrypted (e.g. a refreshed session re-firing the event).
  if (row.access_token.startsWith('v1.')) {
    await db.account.update({
      where: { id: row.id },
      data: { tokenValidatedAt: new Date(), isOwnerToken: isOwner },
    })
    return
  }

  await db.account.update({
    where: { id: row.id },
    data: {
      access_token: encryptSecret(row.access_token),
      isOwnerToken: isOwner,
      tokenValidatedAt: new Date(),
    },
  })
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
