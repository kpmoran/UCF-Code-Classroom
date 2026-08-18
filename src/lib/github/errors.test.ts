import { describe, expect, it } from 'vitest'

import { GitHubDomainError, toDomainError } from './errors'

/** Shape an Octokit-style error the way @octokit/request throws it. */
function octokitError(opts: {
  status?: number
  message?: string
  headers?: Record<string, string>
  errors?: Array<{ message?: string; field?: string }>
}) {
  return {
    status: opts.status,
    message: opts.message,
    response: {
      headers: opts.headers ?? {},
      data: { message: opts.message, errors: opts.errors },
    },
  }
}

describe('toDomainError — rate limiting', () => {
  it('treats 403 with retry-after as a retryable secondary limit', () => {
    const e = toDomainError(
      octokitError({ status: 403, message: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '42' } }),
      'generate repo',
    )
    expect(e.kind).toBe('SecondaryRateLimited')
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(42_000)
  })

  it('recognizes the secondary limit from the message alone', () => {
    // GitHub does not always send retry-after; falling back to a full minute
    // matters because retrying sooner extends the block.
    const e = toDomainError(
      octokitError({ status: 403, message: 'You have exceeded a secondary rate limit.' }),
      'add collaborator',
    )
    expect(e.kind).toBe('SecondaryRateLimited')
    expect(e.retryAfterMs).toBe(60_000)
  })

  it('handles 429 as a secondary limit', () => {
    const e = toDomainError(
      octokitError({ status: 429, headers: { 'retry-after': '5' } }),
      'put file',
    )
    expect(e.kind).toBe('SecondaryRateLimited')
    expect(e.retryAfterMs).toBe(5_000)
  })

  it('treats an exhausted hourly quota as a primary limit and waits for reset', () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 600
    const e = toDomainError(
      octokitError({
        status: 403,
        message: 'API rate limit exceeded',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) },
      }),
      'generate repo',
    )
    expect(e.kind).toBe('PrimaryRateLimited')
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBeGreaterThan(500_000)
  })
})

describe('toDomainError — permissions', () => {
  it('maps 401 to an invalid token with a reconnect hint', () => {
    const e = toDomainError(octokitError({ status: 401, message: 'Bad credentials' }), 'create team')
    expect(e.kind).toBe('TokenInvalid')
    expect(e.retryable).toBe(false)
    expect(e.userMessage).toMatch(/reconnect/i)
  })

  it('distinguishes the org-owner failure from a generic 403', () => {
    // This is the exact failure when a team invitation is attempted with an
    // installation token instead of an owner token; it must not be reported as
    // a generic permission problem or the fix is unguessable.
    const e = toDomainError(
      octokitError({
        status: 403,
        message: 'You must be an organization owner to add members to a team',
      }),
      'add team membership for user',
    )
    expect(e.kind).toBe('NotOrgOwner')
    expect(e.userMessage).toMatch(/organization owner/i)
    expect(e.userMessage).toMatch(/Owner \(not just an Admin\)/)
  })

  it('names the Workflows permission when that is what GitHub wanted', () => {
    // GitHub's message body is the generic "Resource not accessible by
    // integration"; the actual requirement appears only in this header. Verified
    // against a live org while writing .github/workflows/.
    const e = toDomainError(
      octokitError({
        status: 403,
        message: 'Resource not accessible by integration',
        headers: { 'x-accepted-github-permissions': 'contents=write; contents=write,workflows=write' },
      }),
      'put file .github/workflows/uccc-autograding.yml in repo org/hw1-abc',
    )
    expect(e.kind).toBe('InsufficientPermissions')
    expect(e.userMessage).toMatch(/“Workflows” permission/)
    expect(e.userMessage).toMatch(/Read & write/)
  })

  it('maps other 403s to insufficient permissions', () => {
    const e = toDomainError(
      octokitError({ status: 403, message: 'Resource not accessible by integration' }),
      'archive repo',
    )
    expect(e.kind).toBe('InsufficientPermissions')
    expect(e.retryable).toBe(false)
  })
})

describe('toDomainError — not found', () => {
  it('maps a template 404 using the operation context', () => {
    const e = toDomainError(
      octokitError({ status: 404, message: 'Not Found' }),
      'generate repo org/hw1-abc from template org/hw1-template',
    )
    expect(e.kind).toBe('TemplateNotFound')
  })

  it('maps a user 404 to UserNotFound', () => {
    const e = toDomainError(
      octokitError({ status: 404, message: 'Not Found' }),
      'add collaborator user jdoe to repo org/hw1-jdoe',
    )
    expect(e.kind).toBe('UserNotFound')
    expect(e.userMessage).toMatch(/renamed or deleted/)
  })

  it('maps an org 404 to OrgNotFound', () => {
    const e = toDomainError(
      octokitError({ status: 404, message: 'Not Found' }),
      'list members of org ucf-cop4331',
    )
    expect(e.kind).toBe('OrgNotFound')
  })
})

describe('toDomainError — 422 validation', () => {
  it('recognizes a taken repository name from the field errors', () => {
    const e = toDomainError(
      octokitError({
        status: 422,
        message: 'Repository creation failed.',
        errors: [{ field: 'name', message: 'name already exists on this account' }],
      }),
      'generate repo',
    )
    expect(e.kind).toBe('RepoNameTaken')
    expect(e.retryable).toBe(false)
    expect(e.userMessage).toMatch(/already exists/)
  })

  it('folds GitHub’s errors[] details into the message and exposes them', () => {
    // Regression: GitHub answers a feedback-PR-with-no-changes with a top-level
    // "Validation Failed" and the real reason only in errors[]. Matching just the
    // top-level message turned an expected state into a hard job failure.
    const e = toDomainError(
      octokitError({
        status: 422,
        message: 'Validation Failed',
        errors: [{ message: 'No commits between feedback and main' }],
      }),
      'create feedback pull request',
    )

    expect(e.details).toEqual(['No commits between feedback and main'])
    expect(e.message).toContain('No commits between feedback and main')
    // The instructor-facing text must not be a bare "Validation Failed".
    expect(e.userMessage).toContain('No commits between feedback and main')
  })

  it('matches patterns that appear only in errors[]', () => {
    const e = toDomainError(
      octokitError({
        status: 422,
        message: 'Validation Failed',
        errors: [{ message: 'org/starter is not a template repository' }],
      }),
      'generate repo',
    )
    expect(e.kind).toBe('TemplateNotATemplate')
  })

  it('recognizes a non-template source repository', () => {
    const e = toDomainError(
      octokitError({ status: 422, message: 'org/starter is not a template repository' }),
      'generate repo from template',
    )
    expect(e.kind).toBe('TemplateNotATemplate')
    expect(e.userMessage).toMatch(/Template repository/)
  })
})

describe('toDomainError — transient failures', () => {
  it('treats a 409 repository conflict as retryable', () => {
    // GitHub answers 409 while a previous operation on the repository settles —
    // reliably reproducible by archiving then immediately deleting. Verified
    // against a live org that the retry succeeds, so this must not be permanent.
    const e = toDomainError(
      octokitError({
        status: 409,
        message: 'A conflicting repository operation is still in progress',
      }),
      'delete repo org/hw1-abc',
    )
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(10_000)
    expect(e.userMessage).toMatch(/retried automatically/)
  })

  it('treats 5xx as retryable', () => {
    const e = toDomainError(octokitError({ status: 502, message: 'Bad gateway' }), 'get repo')
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(30_000)
  })

  it('treats a network error with no status as retryable', () => {
    const e = toDomainError(new Error('ECONNRESET'), 'get repo')
    expect(e.retryable).toBe(true)
  })

  it('treats an unexpected 4xx as permanent', () => {
    const e = toDomainError(octokitError({ status: 400, message: 'Bad request' }), 'get repo')
    expect(e.kind).toBe('Unknown')
    expect(e.retryable).toBe(false)
  })
})

describe('toDomainError — passthrough and context', () => {
  it('returns an existing domain error unchanged', () => {
    const original = new GitHubDomainError({
      kind: 'RepoNameTaken',
      message: 'x',
      userMessage: 'y',
    })
    expect(toDomainError(original, 'anything')).toBe(original)
  })

  it('includes the operation context in the developer-facing message', () => {
    const e = toDomainError(octokitError({ status: 500, message: 'boom' }), 'generate repo org/x')
    expect(e.message).toContain('generate repo org/x')
    expect(e.message).toContain('boom')
  })

  it('does not throw on a null or undefined error', () => {
    expect(() => toDomainError(null, 'ctx')).not.toThrow()
    expect(() => toDomainError(undefined, 'ctx')).not.toThrow()
  })
})
