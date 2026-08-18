import { describe, expect, it } from 'vitest'

import { parseDeadline, parseTemplateReference } from './schemas'

describe('parseTemplateReference', () => {
  it('accepts owner/repo', () => {
    expect(parseTemplateReference('ucf-org/hw1-template', 'fallback')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a bare repo name using the classroom org', () => {
    // The common case: the template lives in the classroom's own organization.
    expect(parseTemplateReference('hw1-template', 'ucf-org')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a full GitHub URL pasted from the browser', () => {
    expect(parseTemplateReference('https://github.com/ucf-org/hw1-template', 'fallback')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a URL with extra path segments, query or fragment', () => {
    expect(
      parseTemplateReference('https://github.com/ucf-org/hw1-template/tree/main', 'x'),
    ).toEqual({ owner: 'ucf-org', repo: 'hw1-template' })
    expect(parseTemplateReference('github.com/ucf-org/hw1-template?tab=readme', 'x')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('strips a trailing .git', () => {
    expect(parseTemplateReference('ucf-org/hw1-template.git', 'x')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('rejects empty or over-deep input', () => {
    expect(parseTemplateReference('', 'x')).toBeNull()
    expect(parseTemplateReference('   ', 'x')).toBeNull()
    expect(parseTemplateReference('a/b/c/d', 'x')).toBeNull()
  })
})

describe('parseDeadline', () => {
  it('returns null for no deadline', () => {
    expect(parseDeadline(null)).toBeNull()
    expect(parseDeadline('')).toBeNull()
  })

  it('parses a datetime-local value', () => {
    const parsed = parseDeadline('2026-09-15T23:59')
    expect(parsed).toBeInstanceOf(Date)
    expect((parsed as Date).getFullYear()).toBe(2026)
  })

  it('distinguishes an unparseable value from no value', () => {
    // Silently treating a typo as "no deadline" would leave the assignment
    // permanently open, which the instructor would not notice.
    expect(parseDeadline('not a date')).toBeUndefined()
    expect(parseDeadline('2026-13-45T99:99')).toBeUndefined()
  })
})
