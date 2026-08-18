import { describe, expect, it } from 'vitest'

import { maskIdentifier } from './join'

describe('maskIdentifier', () => {
  // The roster list is visible to anyone holding the invite link, so it must not
  // publish every classmate's full university identifier. A suffix is enough to
  // distinguish namesakes.
  it('reveals only the last three characters', () => {
    expect(maskIdentifier('nid100000')).toBe('••••••000')
  })

  it('masks a short identifier entirely', () => {
    // Revealing three characters of a short id exposes most of it, so nothing
    // is shown until the mask is at least as long as the visible suffix.
    expect(maskIdentifier('abc')).toBe('•••')
    expect(maskIdentifier('ab')).toBe('••')
    expect(maskIdentifier('abcd')).toBe('••••')
    expect(maskIdentifier('abcdef')).toBe('••••••')
  })

  it('reveals a suffix only from seven characters up', () => {
    expect(maskIdentifier('abcdefg')).toBe('••••efg')
  })

  it('never reveals more than three characters', () => {
    for (const id of ['a', 'ab', 'abcd', 'abcdef', 'abcdefg', 'nid1234567890']) {
      const masked = maskIdentifier(id)!
      const revealed = masked.replace(/•/g, '')
      expect(revealed.length).toBeLessThanOrEqual(3)
    }
  })

  it('preserves the length so it reads as an identifier', () => {
    for (const id of ['ab', 'abcd', 'nid100000']) {
      expect(maskIdentifier(id)!.length).toBe(id.length)
    }
  })

  it('returns null for a missing identifier', () => {
    expect(maskIdentifier(null)).toBeNull()
    expect(maskIdentifier('')).toBeNull()
  })

  it('does not include the original identifier anywhere in the output', () => {
    const id = 'nid987654'
    const masked = maskIdentifier(id)!
    expect(masked).not.toContain(id)
    expect(masked.length).toBe(id.length)
  })
})
