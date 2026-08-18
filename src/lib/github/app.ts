import 'server-only'

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

import { requireGitHubAppConfig } from '@/lib/env'

import { GitHubDomainError, toDomainError } from './errors'
import { acquireContentBudget, reportRateLimited } from './rateLimiter'

/**
 * GitHub App authentication.
 *
 * This is the workhorse credential: it creates repositories, invites
 * collaborators, writes files, opens pull requests, and reads Actions results.
 * It is *not* sufficient for team membership of users who are not yet org
 * members — that needs an org owner's OAuth token, see ownerToken.ts.
 */

const USER_AGENT = 'ucf-code-connect'

/**
 * Octokit authenticated as the App itself (JWT, no installation).
 * Use only for installation discovery; it cannot touch repository content.
 */
export function getAppOctokit(): Octokit {
  const { appId, privateKey } = requireGitHubAppConfig()
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
    userAgent: USER_AGENT,
  })
}

// Installation clients are cached because @octokit/auth-app caches the
// installation token internally and refreshes it before expiry; constructing a
// new client per call would fetch a fresh token every time and burn through the
// 2,000/hour token-creation limit on a large provisioning run.
const installationClients = new Map<string, Octokit>()

export function getInstallationOctokit(installationId: bigint): Octokit {
  const key = installationId.toString()
  const cached = installationClients.get(key)
  if (cached) return cached

  const { appId, privateKey } = requireGitHubAppConfig()
  const client = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId: Number(installationId) },
    userAgent: USER_AGENT,
  })

  installationClients.set(key, client)
  return client
}

/** Drop a cached client, e.g. after the App is uninstalled and reinstalled. */
export function invalidateInstallationClient(installationId: bigint): void {
  installationClients.delete(installationId.toString())
}

/**
 * Run a read-only GitHub call, mapping failures to domain errors.
 *
 * Reads are not metered: GitHub's content-creation limit applies to mutations,
 * and metering reads would waste budget the provisioning jobs need.
 */
export async function githubRead<T>(
  context: string,
  installationId: bigint,
  fn: (octokit: Octokit) => Promise<T>,
): Promise<T> {
  try {
    return await fn(getInstallationOctokit(installationId))
  } catch (error) {
    const domain = toDomainError(error, context)
    if (domain.kind === 'SecondaryRateLimited' || domain.kind === 'PrimaryRateLimited') {
      await reportRateLimited(installationId, domain.retryAfterMs ?? 60_000)
    }
    throw domain
  }
}

/**
 * Run a content-creating GitHub call against the shared rate budget.
 *
 * Throws a retryable `SecondaryRateLimited` domain error when there is no budget
 * — the caller (a job handler) is expected to reschedule itself for
 * `retryAfterMs` rather than block, so one throttled installation does not tie
 * up a worker slot.
 */
export async function githubMutate<T>(
  context: string,
  installationId: bigint,
  fn: (octokit: Octokit) => Promise<T>,
  cost = 1,
): Promise<T> {
  const budget = await acquireContentBudget(installationId, cost)
  if (!budget.ok) {
    throw new GitHubDomainError({
      kind: 'SecondaryRateLimited',
      message: `${context}: local rate budget exhausted (${budget.reason})`,
      userMessage:
        'Paused to stay within GitHub’s rate limits. This will continue automatically.',
      retryAfterMs: budget.retryAfterMs,
      retryable: true,
    })
  }

  try {
    return await fn(getInstallationOctokit(installationId))
  } catch (error) {
    const domain = toDomainError(error, context)
    // GitHub disagreed with our accounting; trust GitHub and pause everyone.
    if (domain.kind === 'SecondaryRateLimited' || domain.kind === 'PrimaryRateLimited') {
      await reportRateLimited(installationId, domain.retryAfterMs ?? 60_000)
    }
    throw domain
  }
}
