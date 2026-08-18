import { describe, expect, it } from 'vitest'

import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  generateInviteToken,
  safeEqual,
} from './crypto'

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a token', () => {
    // Deliberately not shaped like a real `gho_` token: this repository is public,
    // and a token-shaped literal trips secret scanners on every push forever.
    // AES-GCM does not care about the charset, so the shape buys nothing.
    const token = 'example-not-a-real-token-0123456789abcdef'
    expect(decryptSecret(encryptSecret(token))).toBe(token)
  })

  it('produces different ciphertext for the same plaintext', () => {
    // A fresh IV per call: two instructors with the same token must not be
    // identifiable as such from the stored rows.
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  it('round-trips unicode and empty strings', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('')
    expect(decryptSecret(encryptSecret('Órla — 学生 🎓'))).toBe('Órla — 学生 🎓')
  })

  it('is versioned so the key can be rotated later', () => {
    expect(encryptSecret('x').startsWith('v1.')).toBe(true)
  })

  it('rejects malformed ciphertext', () => {
    expect(() => decryptSecret('nonsense')).toThrow(DecryptionError)
    expect(() => decryptSecret('v1.a.b')).toThrow(/expected 4 dot-separated parts/)
  })

  it('rejects an unknown version', () => {
    const parts = encryptSecret('x').split('.')
    parts[0] = 'v2'
    expect(() => decryptSecret(parts.join('.'))).toThrow(/Unsupported ciphertext version/)
  })

  it('rejects tampered ciphertext rather than returning garbage', () => {
    // GCM authenticates, so flipping a byte must fail loudly. Without this an
    // attacker with DB write access could alter a stored token undetected.
    const parts = encryptSecret('sensitive').split('.')
    const data = Buffer.from(parts[3], 'base64')
    data[0] ^= 0xff
    parts[3] = data.toString('base64')
    expect(() => decryptSecret(parts.join('.'))).toThrow(DecryptionError)
  })

  it('rejects a tampered auth tag', () => {
    const parts = encryptSecret('sensitive').split('.')
    const tag = Buffer.from(parts[2], 'base64')
    tag[0] ^= 0xff
    parts[2] = tag.toString('base64')
    expect(() => decryptSecret(parts.join('.'))).toThrow(DecryptionError)
  })
})

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false on length mismatch without throwing', () => {
    // timingSafeEqual throws on differing lengths; the wrapper must not.
    expect(safeEqual('short', 'much longer value')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })
})

describe('generateInviteToken', () => {
  it('is URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInviteToken))
    expect(tokens.size).toBe(200)
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})
