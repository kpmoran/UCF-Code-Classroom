/**
 * URL slugs for classrooms.
 *
 * A classroom's slug appears in every link an instructor shares and in students'
 * bookmarks, so it is generated once at creation and never regenerated when the
 * name is edited later. Pure and dependency-free so the rules are testable.
 */

const MAX_SLUG_LENGTH = 60

/** Lowercase, hyphen-separated, ASCII-only. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Drop combining marks so accented letters degrade to their base form
    // instead of vanishing entirely.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
}

/**
 * Build a classroom slug from the parts an instructor supplies.
 *
 * Prefers `courseCode-term` ("cop4331-fall-2026") because that is what an
 * instructor recognizes in a URL, and falls back to the classroom name when no
 * course code is given.
 */
export function buildClassroomSlug(input: {
  name: string
  courseCode?: string | null
  term?: string | null
}): string {
  const fromCourse = [input.courseCode, input.term].filter(Boolean).join(' ')
  const candidate = slugify(fromCourse) || slugify(input.name)

  // Every fallback produced nothing usable — e.g. a name written entirely in a
  // non-Latin script. Callers must not end up with an empty path segment.
  return candidate || 'classroom'
}

/**
 * Resolve a collision by appending `-2`, `-3`, ... Mirrors the repository
 * naming rule so the two behave predictably alike.
 */
export function dedupeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base

  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const trimmed =
      base.length + suffix.length > MAX_SLUG_LENGTH
        ? base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')
        : base
    const candidate = `${trimmed}${suffix}`
    if (!taken.has(candidate)) return candidate
  }

  throw new Error(`Could not find an unused slug based on "${base}"`)
}
