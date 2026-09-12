import { describe, expect, it } from 'vitest'

import { createAssignmentSchema, parseDeadline, parseRepoReference } from './schemas'

describe('parseRepoReference', () => {
  it('accepts owner/repo', () => {
    expect(parseRepoReference('ucf-org/hw1-template', 'fallback')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a bare repo name using the classroom org', () => {
    // The common case: the template lives in the classroom's own organization.
    expect(parseRepoReference('hw1-template', 'ucf-org')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a full GitHub URL pasted from the browser', () => {
    expect(parseRepoReference('https://github.com/ucf-org/hw1-template', 'fallback')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('accepts a URL with extra path segments, query or fragment', () => {
    expect(
      parseRepoReference('https://github.com/ucf-org/hw1-template/tree/main', 'x'),
    ).toEqual({ owner: 'ucf-org', repo: 'hw1-template' })
    expect(parseRepoReference('github.com/ucf-org/hw1-template?tab=readme', 'x')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('strips a trailing .git', () => {
    expect(parseRepoReference('ucf-org/hw1-template.git', 'x')).toEqual({
      owner: 'ucf-org',
      repo: 'hw1-template',
    })
  })

  it('rejects empty or over-deep input', () => {
    expect(parseRepoReference('', 'x')).toBeNull()
    expect(parseRepoReference('   ', 'x')).toBeNull()
    expect(parseRepoReference('a/b/c/d', 'x')).toBeNull()
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

/**
 * What the form actually sends.
 *
 * Built from a real FormData rather than a hand-written object, because the bug
 * these cover lived entirely in the difference between the two: `FormData.get`
 * answers `null` for a field that was never rendered, and an object literal that
 * simply omits the key answers `undefined`. Only one of those reproduces it.
 */
function submission(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)

  return {
    classroomId: 'c1',
    title: fd.get('title'),
    type: fd.get('type'),
    template: fd.get('template'),
    repoPrefix: fd.get('repoPrefix'),
    visibility: fd.get('visibility'),
    studentPermission: fd.get('studentPermission'),
    deadline: fd.get('deadline') ?? undefined,
    lockOnDeadline: false,
    feedbackPrEnabled: false,
    autogradeEnabled: false,
    projectBoardEnabled: false,
    maxTeams: fd.get('maxTeams') || undefined,
    maxTeamSize: fd.get('maxTeamSize') || undefined,
    repoSource: fd.get('repoSource') || undefined,
    publish: true,
  }
}

const BASE = {
  title: 'CEN 5016 Project',
  repoPrefix: 'proj',
  visibility: 'PRIVATE',
  studentPermission: 'PUSH',
}

describe('createAssignmentSchema', () => {
  /*
   * The regression. Under EXISTING the template picker is not rendered, so the
   * field is absent from the submission entirely — and the form reported "Please
   * correct the highlighted fields" while highlighting none, because the only
   * invalid field was the hidden one.
   */
  it.each([
    ['INDIVIDUAL', 'EXISTING'],
    ['GROUP', 'EXISTING'],
  ])('accepts a %s assignment with repoSource %s and no template field', (type, repoSource) => {
    const parsed = createAssignmentSchema.safeParse(
      submission({ ...BASE, type, repoSource }),
    )
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    if (parsed.success) expect(parsed.data.template).toBeUndefined()
  })

  it.each([
    ['INDIVIDUAL', 'CREATE'],
    ['GROUP', 'CREATE'],
  ])('still accepts a %s assignment with repoSource %s and a blank template', (type, repoSource) => {
    const parsed = createAssignmentSchema.safeParse(
      submission({ ...BASE, type, repoSource, template: '' }),
    )
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    if (parsed.success) expect(parsed.data.template).toBeUndefined()
  })

  it('keeps a template that was supplied', () => {
    const parsed = createAssignmentSchema.safeParse(
      submission({ ...BASE, type: 'INDIVIDUAL', repoSource: 'CREATE', template: 'org/tpl' }),
    )
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.template).toBe('org/tpl')
  })

  // Still rejected: too short to be owner/repo, and typed rather than omitted.
  it('rejects a template too short to be a repository reference', () => {
    const parsed = createAssignmentSchema.safeParse(
      submission({ ...BASE, type: 'INDIVIDUAL', repoSource: 'CREATE', template: 'x' }),
    )
    expect(parsed.success).toBe(false)
  })
})
