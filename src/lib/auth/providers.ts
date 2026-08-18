/**
 * Provider identifiers.
 *
 * Kept in their own dependency-free module because `src/lib/github/**` needs the
 * owner-provider id to find the right `Account` row. Importing it from
 * `auth/config.ts` would drag NextAuth — and through it `next/server` — into the
 * GitHub layer, which breaks anything running outside the Next.js bundler, such
 * as the job worker under test.
 */

/** Auth.js provider id for the elevated org-owner account link. */
export const OWNER_PROVIDER_ID = 'github-owner'

/** Auth.js provider id for ordinary sign-in. */
export const GITHUB_PROVIDER_ID = 'github'
