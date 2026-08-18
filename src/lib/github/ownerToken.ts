import 'server-only'

import { Octokit } from '@octokit/rest'

import { OWNER_PROVIDER_ID } from '@/lib/auth/providers'
import { decryptSecret, DecryptionError } from '@/lib/crypto'
import { db } from '@/lib/db'

import { GitHubDomainError, toDomainError } from './errors'
import { acquireContentBudget, reportRateLimited } from './rateLimiter'

/**
 * The instructor's organization-owner token — the **fallback** credential for
 * team operations.
 *
 * Not normally needed. Verified against a live organization, the App
 * installation token creates teams and manages membership on its own, so group
 * assignments work with nothing connected here (see operations/teams.ts for the
 * evidence and the fallback logic).
 *
 * It exists because GitHub's documentation states that inviting a user who is not
 * yet an organization member requires an org **owner**, and our evidence to the
 * contrary is strong but indirect. If GitHub ever refuses the App token on
 * authorization grounds, `teamMutate` retries as the instructor rather than
 * failing the assignment.
 *
 * Being a personal credential, it is stored encrypted (see crypto.ts) and used
 * for nothing beyond org and team membership.
 */

export class OwnerTokenUnavailableError extends Error {
  readonly userMessage: string

  constructor(userMessage: string) {
    super(userMessage)
    this.name = 'OwnerTokenUnavailableError'
    this.userMessage = userMessage
  }
}

const RECONNECT_HINT =
  'Open classroom settings and use “Connect GitHub as organization owner”.'

/**
 * Resolve and decrypt the owner token for a classroom.
 *
 * Every failure path returns an actionable message rather than a null, because
 * the recovery is always the same specific instructor action and a silent null
 * would surface much later as an opaque GitHub 403.
 */
export async function getOwnerToken(classroomId: string): Promise<string> {
  const classroom = await db.classroom.findUnique({
    where: { id: classroomId },
    select: { ownerTokenUserId: true, githubOrgLogin: true },
  })

  if (!classroom) {
    throw new OwnerTokenUnavailableError('That classroom no longer exists.')
  }

  if (!classroom.ownerTokenUserId) {
    throw new OwnerTokenUnavailableError(
      `No organization owner is connected for ${classroom.githubOrgLogin}, so students ` +
        `cannot be added to GitHub teams. ${RECONNECT_HINT}`,
    )
  }

  const account = await db.account.findFirst({
    where: {
      userId: classroom.ownerTokenUserId,
      provider: OWNER_PROVIDER_ID,
      isOwnerToken: true,
    },
    select: { access_token: true, scope: true },
    orderBy: { tokenValidatedAt: 'desc' },
  })

  if (!account?.access_token) {
    throw new OwnerTokenUnavailableError(
      `The connected organization owner has no stored GitHub token. ${RECONNECT_HINT}`,
    )
  }

  // Deliberately no scope check here. A GitHub App user access token always
  // reports an empty scope string — its power is the intersection of the App's
  // installed permissions and the user's own. Requiring `admin:org` in `scope`
  // would therefore reject every valid token. The real precondition is that the
  // user is an organization *owner*, which is verified separately by
  // `checkOrgOwnership()` when the classroom is created and re-checked from
  // settings.

  try {
    return decryptSecret(account.access_token)
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new OwnerTokenUnavailableError(
        `The stored GitHub token could not be decrypted, usually because ENCRYPTION_KEY ` +
          `changed. ${RECONNECT_HINT}`,
      )
    }
    throw error
  }
}

export async function getOwnerOctokit(classroomId: string): Promise<Octokit> {
  return new Octokit({
    auth: await getOwnerToken(classroomId),
    userAgent: 'ucf-code-connect',
  })
}

/**
 * Run an org/team mutation as the organization owner.
 *
 * Shares the same content budget as App calls: GitHub's secondary limits are
 * enforced per installation and per user, and team invitations count. Metering
 * them separately would let a group-assignment provision trip the limit that
 * the individual-assignment path is carefully staying under.
 */
export async function ownerMutate<T>(
  context: string,
  classroomId: string,
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

  const octokit = await getOwnerOctokit(classroomId)

  try {
    const result = await fn(octokit)
    await markTokenValid(classroomId)
    return result
  } catch (error) {
    const domain = toDomainError(error, context)
    if (domain.kind === 'SecondaryRateLimited' || domain.kind === 'PrimaryRateLimited') {
      await reportRateLimited(installationId, domain.retryAfterMs ?? 60_000)
    }
    throw domain
  }
}

/** Read as the organization owner, without spending content budget. */
export async function ownerRead<T>(
  context: string,
  classroomId: string,
  fn: (octokit: Octokit) => Promise<T>,
): Promise<T> {
  const octokit = await getOwnerOctokit(classroomId)
  try {
    const result = await fn(octokit)
    await markTokenValid(classroomId)
    return result
  } catch (error) {
    throw toDomainError(error, context)
  }
}

/**
 * Stamp the token as known-good. The settings page uses the age of this to warn
 * that a token has not been exercised recently, which is the early signal that
 * an instructor revoked access or left the organization.
 */
async function markTokenValid(classroomId: string): Promise<void> {
  const classroom = await db.classroom.findUnique({
    where: { id: classroomId },
    select: { ownerTokenUserId: true },
  })
  if (!classroom?.ownerTokenUserId) return

  await db.account.updateMany({
    where: {
      userId: classroom.ownerTokenUserId,
      provider: OWNER_PROVIDER_ID,
      isOwnerToken: true,
    },
    data: { tokenValidatedAt: new Date() },
  })
}

/**
 * Whether a usable owner token exists, for rendering warnings without throwing.
 * Returns the reason when it does not, so the UI can explain the consequence.
 */
export async function checkOwnerToken(
  classroomId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await getOwnerToken(classroomId)
    return { ok: true }
  } catch (error) {
    if (error instanceof OwnerTokenUnavailableError) {
      return { ok: false, reason: error.userMessage }
    }
    throw error
  }
}
