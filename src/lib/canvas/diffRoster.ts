import type { ParsedRosterRow } from './parseRoster'

/**
 * Compare a parsed CSV against the roster already stored.
 *
 * Import is always a **preview then confirm**, never a blind overwrite. The
 * reason is concrete: an instructor who exports the wrong section, or a Canvas
 * export missing SIS permissions, would otherwise silently drop students who
 * have already linked their GitHub account and been given repositories. Showing
 * the consequence first — and marking removals that would affect a registered
 * student — is what makes the operation safe to repeat mid-semester.
 *
 * Pure: takes plain objects, returns a plan. The caller applies it.
 */

export type ExistingRosterEntry = {
  id: string
  displayName: string
  sisUserId: string | null
  sisLoginId: string | null
  email: string | null
  section: string | null
  /** Set once a student has linked their GitHub account to this entry. */
  claimedByUserId: string | null
  claimedByLogin: string | null
  removedAt: Date | null
  /** Repositories provisioned for the claiming student in this classroom. */
  repoCount: number
}

export type FieldChange = {
  field: 'displayName' | 'sisLoginId' | 'email' | 'section'
  from: string | null
  to: string | null
}

export type RosterDiff = {
  /** In the CSV, not on the roster. */
  added: ParsedRosterRow[]
  /** Matched, with differing details. */
  updated: Array<{
    existing: ExistingRosterEntry
    parsed: ParsedRosterRow
    changes: FieldChange[]
  }>
  /** Matched, identical. */
  unchanged: Array<{ existing: ExistingRosterEntry; parsed: ParsedRosterRow }>
  /** On the roster, absent from the CSV — i.e. dropped the course. */
  removed: ExistingRosterEntry[]
  /**
   * Previously removed entries present in the CSV again — a student who dropped
   * and re-added. Restored rather than duplicated, so their claim and repos
   * survive.
   */
  restored: Array<{ existing: ExistingRosterEntry; parsed: ParsedRosterRow }>
  /**
   * Removals that would affect a student who has already registered. Surfaced
   * separately because these are the ones an instructor must look at.
   */
  destructive: Array<{ entry: ExistingRosterEntry; consequence: string }>
  /** How each CSV row was matched, for explaining the preview. */
  matchedBy: Record<'sisUserId' | 'sisLoginId' | 'displayName', number>
}

function keyOf(
  row: { sisUserId: string | null; sisLoginId: string | null; displayName: string },
  by: 'sisUserId' | 'sisLoginId' | 'displayName',
): string | null {
  const value =
    by === 'sisUserId' ? row.sisUserId : by === 'sisLoginId' ? row.sisLoginId : row.displayName
  if (!value) return null
  return by === 'displayName' ? value.trim().toLowerCase() : value.trim()
}

/**
 * Match on the most reliable identifier available.
 *
 * SIS User ID first because it is institution-assigned and stable. Login id
 * next. Display name last and reluctantly: two students can share a name, and a
 * name change between exports looks like a drop plus an add. Name matches are
 * counted so the preview can say how many rows relied on it.
 */
export function diffRoster(
  parsedRows: readonly ParsedRosterRow[],
  existingEntries: readonly ExistingRosterEntry[],
): RosterDiff {
  const diff: RosterDiff = {
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    restored: [],
    destructive: [],
    matchedBy: { sisUserId: 0, sisLoginId: 0, displayName: 0 },
  }

  const byStrategy = {
    sisUserId: new Map<string, ExistingRosterEntry>(),
    sisLoginId: new Map<string, ExistingRosterEntry>(),
    displayName: new Map<string, ExistingRosterEntry>(),
  }

  for (const entry of existingEntries) {
    for (const strategy of ['sisUserId', 'sisLoginId', 'displayName'] as const) {
      const key = keyOf(entry, strategy)
      // First writer wins: a duplicate name must not let a later entry shadow
      // an earlier one.
      if (key && !byStrategy[strategy].has(key)) byStrategy[strategy].set(key, entry)
    }
  }

  const consumed = new Set<string>()

  for (const parsed of parsedRows) {
    let match: ExistingRosterEntry | undefined
    let matchedVia: keyof RosterDiff['matchedBy'] | null = null

    for (const strategy of ['sisUserId', 'sisLoginId', 'displayName'] as const) {
      const key = keyOf(parsed, strategy)
      if (!key) continue
      const candidate = byStrategy[strategy].get(key)
      if (candidate && !consumed.has(candidate.id)) {
        match = candidate
        matchedVia = strategy
        break
      }
    }

    if (!match || !matchedVia) {
      diff.added.push(parsed)
      continue
    }

    consumed.add(match.id)
    diff.matchedBy[matchedVia] += 1

    const changes: FieldChange[] = []
    const compare = (
      field: FieldChange['field'],
      from: string | null,
      to: string | null,
    ) => {
      const a = from?.trim() || null
      const b = to?.trim() || null
      // An export lacking a column must not blank out data we already have.
      if (b !== null && a !== b) changes.push({ field, from: a, to: b })
    }

    compare('displayName', match.displayName, parsed.displayName)
    compare('sisLoginId', match.sisLoginId, parsed.sisLoginId)
    compare('email', match.email, parsed.email)
    compare('section', match.section, parsed.section)

    if (match.removedAt) {
      diff.restored.push({ existing: match, parsed })
    } else if (changes.length > 0) {
      diff.updated.push({ existing: match, parsed, changes })
    } else {
      diff.unchanged.push({ existing: match, parsed })
    }
  }

  for (const entry of existingEntries) {
    if (consumed.has(entry.id)) continue
    // Already removed and still absent: nothing to report.
    if (entry.removedAt) continue

    diff.removed.push(entry)

    if (entry.claimedByUserId) {
      const who = entry.claimedByLogin ? `@${entry.claimedByLogin}` : 'a linked GitHub account'
      diff.destructive.push({
        entry,
        consequence:
          entry.repoCount > 0
            ? `${entry.displayName} has registered as ${who} and has ${entry.repoCount} ` +
              `assignment ${entry.repoCount === 1 ? 'repository' : 'repositories'}. ` +
              'Removing them here does not delete anything on GitHub, but they will lose ' +
              'access to this classroom in UCF Code Classroom.'
            : `${entry.displayName} has registered as ${who}. Removing them here will ` +
              'unlink that account from this classroom.',
      })
    }
  }

  return diff
}

/** Whether applying this diff changes anything at all. */
export function diffIsEmpty(diff: RosterDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.updated.length === 0 &&
    diff.removed.length === 0 &&
    diff.restored.length === 0
  )
}
