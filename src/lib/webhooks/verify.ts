import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * GitHub webhook signature verification.
 *
 * Extracted from the route so it can be tested directly. This is the only thing
 * standing between a public endpoint and anyone who wants to post a
 * `workflow_run` payload that awards full marks, so it is worth testing against
 * forged, truncated, and absent signatures rather than only the happy path.
 */

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing-secret' | 'missing-signature' | 'malformed' | 'mismatch' }

/**
 * Compare a delivery's signature header against the body.
 *
 * Uses a constant-time comparison: a plain `===` on the hex digest leaks, through
 * timing, how many leading bytes a forged signature got right, which is enough to
 * forge one byte at a time.
 */
export function verifyGitHubSignature(
  body: string,
  signatureHeader: string | null,
  secret: string,
): VerifyResult {
  if (!secret) return { ok: false, reason: 'missing-secret' }
  if (!signatureHeader) return { ok: false, reason: 'missing-signature' }

  // GitHub sends `sha256=<hex>`. Reject anything else outright rather than trying
  // to interpret it — an unrecognised algorithm prefix is not something to accept.
  if (!/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) {
    return { ok: false, reason: 'malformed' }
  }

  const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

  const provided = Buffer.from(signatureHeader, 'utf8')
  const computed = Buffer.from(expected, 'utf8')

  // Lengths are equal by construction after the regex, but timingSafeEqual throws
  // on a mismatch so it is checked rather than assumed.
  if (provided.length !== computed.length) return { ok: false, reason: 'mismatch' }

  return timingSafeEqual(provided, computed) ? { ok: true } : { ok: false, reason: 'mismatch' }
}

/** Compute the header GitHub would send, for tests and for local forwarding. */
export function computeGitHubSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}
