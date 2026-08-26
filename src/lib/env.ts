import 'server-only'

import { z } from 'zod'

/**
 * Validated server environment.
 *
 * Misconfiguration here is the single most likely cause of a confusing failure
 * in this app (a missing private key surfaces as an opaque GitHub 401 much
 * later), so we fail loudly at startup instead. Values that are only needed
 * once a GitHub App is registered are optional at the schema level and checked
 * by `requireGitHubAppConfig()` at the point of use — that way the app still
 * boots for local UI work before you have an App.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),

  AUTH_SECRET: z.string().min(1, 'AUTH_SECRET is required (openssl rand -base64 32)'),
  AUTH_GITHUB_ID: z.string().default(''),
  AUTH_GITHUB_SECRET: z.string().default(''),

  GITHUB_APP_ID: z.string().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),

  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required (openssl rand -base64 32)')
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32
        } catch {
          return false
        }
      },
      'ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded',
    ),

  /*
   * Our own ceiling on content-creating calls, deliberately below GitHub's.
   *
   * GitHub documents a *secondary* limit of 80 content-generating requests per minute
   * and 500 per hour — separate from the primary 5,000/hour for an installation, and
   * easy to miss because it is on a different page. Staying under it is the point: the
   * same allowance also covers whatever staff are doing in the web UI at the time, so
   * the remaining headroom is not as large as the arithmetic suggests.
   *
   * The per-minute figure started at 6, which was far too tight: provisioning a single
   * repository spends most of it, so the project-board job queued behind it was refused
   * by us, not by GitHub, and a twelve-student backfill filled the page with errors.
   */
  GITHUB_CONTENT_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  GITHUB_CONTENT_CALLS_PER_HOUR: z.coerce.number().int().positive().default(400),

  RUN_WORKER: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  /**
   * GitHub logins that are always site admins, comma-separated.
   *
   * The bootstrap problem this solves: on a fresh deployment the database has no
   * users, so there is nobody who can grant anyone else anything. Deriving admin
   * status from server configuration rather than from a row means the first person
   * in is already an admin, with no "first user to sign in wins" race — which on a
   * public URL is a race an attacker can enter.
   *
   * Read on every request rather than written to the user row, so revoking someone
   * is a config change and a restart, not a database edit.
   */
  SITE_ADMIN_LOGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== ''),
    ),
})

function load() {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    )
  }
  return parsed.data
}

export const env = load()

export type Env = typeof env

/**
 * GitHub App credentials, or a clear explanation of what is missing.
 *
 * Call this from anything that talks to GitHub as the App. The private key is
 * accepted either as a PEM with literal `\n` escapes or as base64, because both
 * forms are what people end up with after copying a downloaded .pem into an
 * environment variable.
 */
export function requireGitHubAppConfig(): {
  appId: string
  privateKey: string
  webhookSecret: string
} {
  const missing: string[] = []
  if (!env.GITHUB_APP_ID) missing.push('GITHUB_APP_ID')
  if (!env.GITHUB_APP_PRIVATE_KEY) missing.push('GITHUB_APP_PRIVATE_KEY')
  if (!env.GITHUB_WEBHOOK_SECRET) missing.push('GITHUB_WEBHOOK_SECRET')
  if (missing.length > 0) {
    throw new Error(
      `GitHub App is not configured. Missing: ${missing.join(', ')}. ` +
        'See "GitHub App setup" in README.md.',
    )
  }

  return {
    appId: env.GITHUB_APP_ID,
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  }
}

export function normalizePrivateKey(raw: string): string {
  const withNewlines = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  if (withNewlines.includes('-----BEGIN')) return withNewlines

  // Not a PEM, so assume base64 of one.
  const decoded = Buffer.from(withNewlines, 'base64').toString('utf8')
  if (decoded.includes('-----BEGIN')) return decoded

  throw new Error(
    'GITHUB_APP_PRIVATE_KEY is neither a PEM nor base64-encoded PEM. ' +
      'Expected the .pem file downloaded from the GitHub App settings page.',
  )
}

export function requireGitHubOAuthConfig(): { clientId: string; clientSecret: string } {
  if (!env.AUTH_GITHUB_ID || !env.AUTH_GITHUB_SECRET) {
    throw new Error(
      'GitHub OAuth is not configured. Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET ' +
        'from your GitHub App\'s OAuth credentials. See README.md.',
    )
  }
  return { clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }
}
