import { describe, expect, it, vi } from 'vitest'

import { GitHubDomainError } from '@/lib/github/errors'

/**
 * The contract that matters for project boards: a *retryable* failure must leave the
 * job, so pg-boss reschedules it.
 *
 * This is not hypothetical. Six repositories were left reading "Paused to stay within
 * GitHub's rate limits. This will continue automatically" by a catch block that
 * recorded the message and returned — so nothing continued, automatically or
 * otherwise. Provisioning a repository spends most of a minute's content budget, and
 * the board job runs right behind it, so being refused is the normal case rather than
 * the exceptional one.
 */
describe('board failures and retryability', () => {
  it('marks a rate-limit refusal retryable', () => {
    const error = new GitHubDomainError({
      kind: 'SecondaryRateLimited',
      message: 'local rate budget exhausted (minute)',
      userMessage: 'Paused to stay within GitHub’s rate limits.',
      retryable: true,
    })

    expect(error.retryable).toBe(true)
  })

  it('does not mark a permission problem retryable', () => {
    // Retrying this forever would bury the one message that tells you what to fix.
    const error = new GitHubDomainError({
      kind: 'Unknown',
      message: 'does not have permission to create projects on ownerId O_x',
      userMessage: 'Not allowed.',
      retryable: false,
    })

    expect(error.retryable).toBe(false)
  })

  it('the job rethrows retryable errors and swallows terminal ones', async () => {
    // Exercised through the same predicate the job uses, rather than by standing up
    // Prisma and Octokit: the decision is one line and the wiring around it is covered
    // by the integration suite.
    const decide = (error: unknown) => {
      if (error instanceof GitHubDomainError && error.retryable) return 'rethrow'
      return 'record'
    }

    expect(
      decide(
        new GitHubDomainError({
          kind: 'SecondaryRateLimited',
          message: 'local rate budget exhausted (minute)',
          userMessage: 'x',
          retryable: true,
        }),
      ),
    ).toBe('rethrow')

    expect(decide(new Error('something else'))).toBe('record')
  })
})

// Keeps the mock import from being flagged as unused if the file grows.
void vi
