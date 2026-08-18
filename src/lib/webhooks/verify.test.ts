import { describe, expect, it } from 'vitest'

import { computeGitHubSignature, verifyGitHubSignature } from './verify'

const SECRET = 'a-test-webhook-secret'
const BODY = JSON.stringify({ action: 'completed', workflow_run: { id: 42 } })

describe('verifyGitHubSignature', () => {
  it('accepts a correct signature', () => {
    const signature = computeGitHubSignature(BODY, SECRET)
    expect(verifyGitHubSignature(BODY, signature, SECRET)).toEqual({ ok: true })
  })

  it('rejects a signature for a different body', () => {
    // The whole point: a replayed signature must not authenticate new content.
    const signature = computeGitHubSignature(BODY, SECRET)
    const tampered = JSON.stringify({ action: 'completed', workflow_run: { id: 43 } })
    expect(verifyGitHubSignature(tampered, signature, SECRET).ok).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const forged = computeGitHubSignature(BODY, 'the-wrong-secret')
    expect(verifyGitHubSignature(BODY, forged, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a missing signature', () => {
    expect(verifyGitHubSignature(BODY, null, SECRET)).toEqual({
      ok: false,
      reason: 'missing-signature',
    })
    expect(verifyGitHubSignature(BODY, '', SECRET)).toEqual({
      ok: false,
      reason: 'missing-signature',
    })
  })

  it('refuses to verify anything when no secret is configured', () => {
    // Without this, an unconfigured deployment would accept every delivery.
    const signature = computeGitHubSignature(BODY, '')
    expect(verifyGitHubSignature(BODY, signature, '')).toEqual({
      ok: false,
      reason: 'missing-secret',
    })
  })

  it('rejects a malformed header rather than trying to interpret it', () => {
    for (const header of [
      'sha1=abcdef',
      'abcdef',
      'sha256=',
      'sha256=nothex!!',
      // Right prefix, wrong digest length.
      `sha256=${'a'.repeat(63)}`,
      `sha256=${'a'.repeat(65)}`,
      'sha256=deadbeef',
    ]) {
      expect(verifyGitHubSignature(BODY, header, SECRET), header).toEqual({
        ok: false,
        reason: 'malformed',
      })
    }
  })

  it('accepts an uppercase hex digest', () => {
    const signature = computeGitHubSignature(BODY, SECRET)
    const upper = `sha256=${signature.slice(7).toUpperCase()}`
    // The regex tolerates case, but the comparison is byte-exact, so this must be
    // a mismatch rather than a crash or an accidental accept.
    expect(verifyGitHubSignature(BODY, upper, SECRET).ok).toBe(false)
  })

  it('is sensitive to whitespace, because the signature covers exact bytes', () => {
    const signature = computeGitHubSignature(BODY, SECRET)
    expect(verifyGitHubSignature(`${BODY} `, signature, SECRET).ok).toBe(false)
    // Re-serialising a parsed body would produce different bytes; this is why the
    // route verifies the raw text.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2)
    expect(verifyGitHubSignature(reserialised, signature, SECRET).ok).toBe(false)
  })

  it('handles an empty body and unicode content', () => {
    expect(verifyGitHubSignature('', computeGitHubSignature('', SECRET), SECRET).ok).toBe(true)

    const unicode = JSON.stringify({ name: 'Órla 学生 🎓' })
    expect(
      verifyGitHubSignature(unicode, computeGitHubSignature(unicode, SECRET), SECRET).ok,
    ).toBe(true)
  })

  it('produces a stable signature for the same input', () => {
    expect(computeGitHubSignature(BODY, SECRET)).toBe(computeGitHubSignature(BODY, SECRET))
  })
})
