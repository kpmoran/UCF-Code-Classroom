import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

import { env } from './env'

/**
 * AES-256-GCM encryption for secrets held at rest in Postgres — specifically the
 * instructor's org-owner OAuth token, which can create and delete repositories
 * across the course organization. A database dump alone must not be enough to
 * act as the instructor on GitHub.
 *
 * Format: `v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>`
 * The version prefix exists so the key can be rotated later without having to
 * guess how existing rows were written.
 */

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'
const IV_LENGTH = 12 // 96 bits, the recommended nonce size for GCM

function key(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'base64')
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split('.')
  if (parts.length !== 4) {
    throw new DecryptionError('Malformed ciphertext: expected 4 dot-separated parts')
  }

  const [version, ivB64, tagB64, dataB64] = parts
  if (version !== VERSION) {
    throw new DecryptionError(`Unsupported ciphertext version "${version}"`)
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // Almost always a rotated or mismatched ENCRYPTION_KEY rather than
    // tampering, so say so — the recovery is to have instructors reconnect.
    throw new DecryptionError(
      'Could not decrypt stored secret. This usually means ENCRYPTION_KEY changed ' +
        'since the value was written; affected users must reconnect their GitHub account.',
    )
  }
}

/**
 * Constant-time string comparison, for webhook signatures and invite tokens
 * where a length-or-content-dependent early return would leak information.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** URL-safe random token for invite links. */
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url')
}
