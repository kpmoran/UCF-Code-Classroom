/**
 * Typed GitHub failures.
 *
 * Raw Octokit errors carry HTTP status plus prose that varies by endpoint, which
 * is useless both for control flow in job handlers and for anything an
 * instructor reads. Every GitHub call is funnelled through `toDomainError` so
 * that callers branch on a type, and the UI shows a sentence that says what to
 * actually do.
 */

export type GitHubErrorKind =
  | 'RepoNameTaken'
  | 'TemplateNotFound'
  | 'TemplateNotATemplate'
  | 'NotOrgOwner'
  | 'InsufficientPermissions'
  | 'UserNotFound'
  | 'SecondaryRateLimited'
  | 'PrimaryRateLimited'
  | 'TokenInvalid'
  | 'OrgNotFound'
  | 'AlreadyExists'
  | 'Unknown'

export class GitHubDomainError extends Error {
  readonly kind: GitHubErrorKind
  readonly status?: number
  /** Advice shown to the instructor. Complete sentences, no jargon. */
  readonly userMessage: string
  /** Wall-clock time to wait before retrying, when GitHub told us. */
  readonly retryAfterMs?: number
  /** False for permanent failures, so the queue stops wasting attempts. */
  readonly retryable: boolean
  /** GitHub's per-field validation messages, where it supplied any. */
  readonly details: string[]

  constructor(opts: {
    kind: GitHubErrorKind
    message: string
    userMessage: string
    status?: number
    retryAfterMs?: number
    retryable?: boolean
    details?: string[]
    cause?: unknown
  }) {
    super(opts.message, { cause: opts.cause })
    this.name = 'GitHubDomainError'
    this.kind = opts.kind
    this.status = opts.status
    this.userMessage = opts.userMessage
    this.retryAfterMs = opts.retryAfterMs
    this.retryable = opts.retryable ?? false
    this.details = opts.details ?? []
  }
}

type OctokitLikeError = {
  status?: number
  message?: string
  response?: {
    headers?: Record<string, string | number | undefined>
    data?: { message?: string; errors?: Array<{ message?: string; field?: string }> }
  }
}

function headerNumber(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): number | undefined {
  const raw = headers?.[name]
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Map an Octokit error onto a domain error.
 *
 * `context` names the attempted operation so log lines identify which of the
 * several calls in a provisioning job failed.
 */
export function toDomainError(error: unknown, context: string): GitHubDomainError {
  if (error instanceof GitHubDomainError) return error

  const err = (error ?? {}) as OctokitLikeError
  const status = err.status
  const apiMessage = err.response?.data?.message ?? err.message ?? 'unknown error'
  const fieldErrors = err.response?.data?.errors ?? []
  const headers = err.response?.headers

  // GitHub's top-level message is often uselessly generic ("Validation Failed")
  // with the real reason in `errors[]` — e.g. "No commits between feedback and
  // main". Fold those in, or both logs and pattern matching below miss the cause.
  const details = fieldErrors.map((e) => e.message).filter((m): m is string => Boolean(m))
  const detailText = details.join('; ')
  const fullMessage = detailText ? `${apiMessage} (${detailText})` : apiMessage

  // Match against message and details together.
  const matchText = detailText ? `${apiMessage} | ${detailText}` : apiMessage

  const base = { status, cause: error, message: `${context}: ${fullMessage}`, details }

  // Rate limiting. GitHub signals the secondary limit with 403 or 429 plus
  // either `retry-after` (seconds) or a message naming it.
  if (status === 429 || status === 403) {
    const retryAfterSec = headerNumber(headers, 'retry-after')
    const remaining = headerNumber(headers, 'x-ratelimit-remaining')
    const resetEpoch = headerNumber(headers, 'x-ratelimit-reset')
    const mentionsSecondary = /secondary rate limit/i.test(matchText)
    const mentionsAbuse = /abuse detection/i.test(matchText)

    if (retryAfterSec !== undefined || mentionsSecondary || mentionsAbuse) {
      return new GitHubDomainError({
        ...base,
        kind: 'SecondaryRateLimited',
        // Default to a full minute: the secondary limit is per-minute, and
        // retrying sooner just extends the block.
        retryAfterMs: (retryAfterSec ?? 60) * 1000,
        retryable: true,
        userMessage:
          'GitHub is rate limiting us. This work is paused and will resume automatically.',
      })
    }

    if (remaining === 0) {
      const waitMs = resetEpoch ? Math.max(0, resetEpoch * 1000 - Date.now()) : 60_000
      return new GitHubDomainError({
        ...base,
        kind: 'PrimaryRateLimited',
        retryAfterMs: waitMs,
        retryable: true,
        userMessage:
          'GitHub’s hourly request limit is exhausted. Work will resume when it resets.',
      })
    }
  }

  if (status === 401) {
    return new GitHubDomainError({
      ...base,
      kind: 'TokenInvalid',
      userMessage:
        'GitHub rejected our credentials. Reconnect your GitHub account in classroom settings.',
    })
  }

  if (status === 403) {
    // Distinguish "the token is fine but lacks org-owner rights" — the failure
    // mode for team membership with an installation token — from other 403s.
    if (/must be an organization owner|not an organization owner/i.test(matchText)) {
      return new GitHubDomainError({
        ...base,
        kind: 'NotOrgOwner',
        userMessage:
          'Only a GitHub organization owner can invite students to teams. Reconnect as ' +
          'org owner in classroom settings, and confirm you are an Owner (not just an Admin) ' +
          'of the organization.',
      })
    }

    /**
     * Writing anything under `.github/workflows/` needs the App's **Workflows**
     * permission, which `Contents: write` does not include. GitHub says so only in
     * the `x-accepted-github-permissions` header, and the message body is the
     * generic "Resource not accessible by integration" — so without reading that
     * header this looks like an ordinary permissions problem and sends the
     * instructor hunting in the wrong place.
     */
    const accepted = String(headers?.['x-accepted-github-permissions'] ?? '')
    if (/workflows=write/.test(accepted)) {
      return new GitHubDomainError({
        ...base,
        kind: 'InsufficientPermissions',
        userMessage:
          'GitHub refused to write the autograding workflow because the UCF-Code-Connect app ' +
          'lacks the “Workflows” permission. Open the app’s settings, set Repository ' +
          'permissions → Workflows to Read & write, then accept the new permission on the ' +
          'organization’s installation page.',
      })
    }

    // GitHub returns this same 403 both for a genuine permissions gap and for a
    // username that does not exist (confirmed against a live org). Callers that
    // can distinguish the cases pre-check the username; when we get here we must
    // not assert a single cause.
    const ambiguousUser = /resource not accessible by integration/i.test(matchText)
    return new GitHubDomainError({
      ...base,
      kind: 'InsufficientPermissions',
      userMessage: ambiguousUser
        ? 'GitHub refused this action. Two things cause this: a GitHub username that does ' +
          'not exist (check for a typo), or the UCF-Code-Connect app missing write access ' +
          'to Administration and Contents on the organization.'
        : 'GitHub refused this action for lack of permission. Check that the ' +
          'UCF-Code-Connect app is installed on the organization with write access to ' +
          'Administration and Contents.',
    })
  }

  if (status === 409) {
    /**
     * GitHub serialises operations on a repository and answers 409 while one is
     * still settling — most reliably when archiving and then deleting the same
     * repository, which is exactly what a removal with the ARCHIVE-then-DELETE
     * sequence does. Verified against a live organization: the conflict clears
     * within seconds and the retried call succeeds.
     *
     * Without this branch a 409 falls through to a *permanent* failure (it is
     * neither 5xx nor a recognised 4xx), so an instructor's deletion would fail
     * once and never be retried.
     */
    return new GitHubDomainError({
      ...base,
      kind: 'Unknown',
      retryable: true,
      retryAfterMs: 10_000,
      userMessage:
        'GitHub is still finishing another change to this repository. This will be retried ' +
        'automatically in a few seconds.',
    })
  }

  if (status === 404) {
    if (/^Not Found$/i.test(apiMessage) && /template/i.test(context)) {
      return new GitHubDomainError({
        ...base,
        kind: 'TemplateNotFound',
        userMessage:
          'The template repository could not be found. Check the owner and name, and ' +
          'confirm the app has access to it.',
      })
    }
    if (/user/i.test(context)) {
      return new GitHubDomainError({
        ...base,
        kind: 'UserNotFound',
        userMessage:
          'That GitHub username does not exist. The student may have renamed or deleted ' +
          'their account.',
      })
    }
    if (/org/i.test(context)) {
      return new GitHubDomainError({
        ...base,
        kind: 'OrgNotFound',
        userMessage:
          'The GitHub organization could not be found, or the app is no longer installed on it.',
      })
    }
    return new GitHubDomainError({
      ...base,
      kind: 'Unknown',
      userMessage: `GitHub could not find something we expected to exist (${context}).`,
    })
  }

  if (status === 422) {
    const nameTaken = fieldErrors.some(
      (e) => e.field === 'name' && /already exists/i.test(e.message ?? ''),
    )
    if (nameTaken || /name already exists/i.test(matchText)) {
      return new GitHubDomainError({
        ...base,
        kind: 'RepoNameTaken',
        userMessage:
          'A repository with that name already exists in the organization. It may be left ' +
          'over from a previous run — rename or delete it, then retry.',
      })
    }
    if (/is not a template/i.test(matchText)) {
      return new GitHubDomainError({
        ...base,
        kind: 'TemplateNotATemplate',
        userMessage:
          'That repository is not marked as a template. Open its GitHub settings and tick ' +
          '“Template repository”, then retry.',
      })
    }
    return new GitHubDomainError({
      ...base,
      kind: 'AlreadyExists',
      // fullMessage, not apiMessage: a bare "Validation Failed" tells the
      // instructor nothing about what to change.
      userMessage: `GitHub rejected the request as invalid: ${fullMessage}`,
    })
  }

  // 5xx and network faults are transient by nature.
  const transient = status === undefined || status >= 500
  return new GitHubDomainError({
    ...base,
    kind: 'Unknown',
    retryable: transient,
    retryAfterMs: transient ? 30_000 : undefined,
    userMessage: transient
      ? 'GitHub returned a temporary error. This will be retried automatically.'
      : `GitHub returned an unexpected error: ${apiMessage}`,
  })
}
