/**
 * Repository naming.
 *
 * Names are derived once at provisioning time and then stored, because renaming
 * a repository after students have cloned it breaks their remotes. Getting the
 * scheme right up front therefore matters more than it looks.
 *
 * Pure and dependency-free so the rules are directly testable.
 */

/** GitHub allows alphanumerics, hyphen, underscore and period, max 100 chars. */
export function sanitizeRepoSegment(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    // Strip combining marks so "Órla" becomes "Orla" rather than "rla".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-_.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .toLowerCase()

  return cleaned
}

export type RepoNameInput = {
  /** Assignment prefix, e.g. "hw1". */
  prefix: string
  /**
   * Preferred student identifier. The SIS login id (NID) is preferred over the
   * GitHub login because it stays stable if a student renames their GitHub
   * account, and it makes repositories sortable alongside the Canvas roster.
   */
  identifier: string
}

const MAX_REPO_NAME = 100

/**
 * Build a repository name, truncating the identifier rather than the prefix so
 * assignment grouping survives; GitHub's 100-character limit only bites with
 * long prefixes and long team names.
 */
export function buildRepoName({ prefix, identifier }: RepoNameInput): string {
  const safePrefix = sanitizeRepoSegment(prefix)
  const safeIdentifier = sanitizeRepoSegment(identifier)

  if (!safeIdentifier) {
    // Everything about the identifier was stripped (e.g. a name in a
    // non-Latin script). Callers must supply a fallback rather than create
    // "hw1-" repositories that collide with each other.
    throw new Error(
      `Cannot build a repository name: identifier "${identifier}" contains no characters ` +
        'GitHub permits. Use the student\'s GitHub login instead.',
    )
  }

  const joined = `${safePrefix}-${safeIdentifier}`
  if (joined.length <= MAX_REPO_NAME) return joined

  const room = MAX_REPO_NAME - safePrefix.length - 1
  return `${safePrefix}-${safeIdentifier.slice(0, Math.max(1, room))}`
}

/**
 * Resolve a collision by appending `-2`, `-3`, ... The suffix goes at the end so
 * the base name stays greppable.
 */
export function dedupeRepoName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base

  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const trimmed =
      base.length + suffix.length > MAX_REPO_NAME
        ? base.slice(0, MAX_REPO_NAME - suffix.length)
        : base
    const candidate = `${trimmed}${suffix}`
    if (!taken.has(candidate)) return candidate
  }

  throw new Error(`Could not find an unused repository name based on "${base}"`)
}

/** Team repository names use the team name as the identifier segment. */
export function buildTeamRepoName(prefix: string, teamName: string): string {
  return buildRepoName({ prefix, identifier: teamName })
}

/**
 * GitHub derives a team's slug from its name. We replicate the rule so a team
 * can be looked up by slug *before* it is created, which is what makes team
 * provisioning idempotent.
 */
export function slugifyTeamName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}
