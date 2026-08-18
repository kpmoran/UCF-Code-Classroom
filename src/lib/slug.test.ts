import { describe, expect, it } from 'vitest'

import { buildClassroomSlug, dedupeSlug, slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Fall 2026')).toBe('fall-2026')
  })

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  COP 4331 -- Fall  ')).toBe('cop-4331-fall')
  })

  it('degrades accents to base letters', () => {
    expect(slugify('Prógramación')).toBe('programacion')
  })

  it('returns empty when nothing usable remains', () => {
    expect(slugify('学生')).toBe('')
    expect(slugify('!!!')).toBe('')
  })

  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(50) + ' ' + 'b'.repeat(30))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('buildClassroomSlug', () => {
  it('prefers course code and term', () => {
    expect(
      buildClassroomSlug({
        name: 'Processes for Object-Oriented Software Development',
        courseCode: 'COP4331',
        term: 'Fall 2026',
      }),
    ).toBe('cop4331-fall-2026')
  })

  it('falls back to the name when there is no course code', () => {
    expect(buildClassroomSlug({ name: 'Advanced Compilers' })).toBe('advanced-compilers')
  })

  it('uses the course code alone when the term is missing', () => {
    expect(buildClassroomSlug({ name: 'x', courseCode: 'COP4331' })).toBe('cop4331')
  })

  it('never returns an empty slug', () => {
    // An empty path segment would make the classroom URL collide with the
    // classroom index route.
    expect(buildClassroomSlug({ name: '学生' })).toBe('classroom')
    expect(buildClassroomSlug({ name: '', courseCode: '', term: '' })).toBe('classroom')
  })
})

describe('dedupeSlug', () => {
  it('returns the base when free', () => {
    expect(dedupeSlug('cop4331-fall-2026', new Set())).toBe('cop4331-fall-2026')
  })

  it('appends an incrementing suffix', () => {
    const taken = new Set(['cop4331-fall-2026'])
    expect(dedupeSlug('cop4331-fall-2026', taken)).toBe('cop4331-fall-2026-2')

    taken.add('cop4331-fall-2026-2')
    expect(dedupeSlug('cop4331-fall-2026', taken)).toBe('cop4331-fall-2026-3')
  })

  it('stays within the length limit and avoids a double hyphen', () => {
    const base = 'a'.repeat(60)
    const result = dedupeSlug(base, new Set([base]))
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result).not.toContain('--')
    expect(result.endsWith('-2')).toBe(true)
  })
})
