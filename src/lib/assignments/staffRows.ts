/**
 * Row shapes for the staff repository table.
 *
 * A group assignment has one repository per team, but staff look for students:
 * "has Ava pushed yet?" is the question, and Ava is a row in the roster, not a
 * team. So the table can be viewed either way, and the pure parts of that — one
 * row per member, and a search that finds a team by any of its members — live
 * here where they can be tested without a browser.
 */

export type RowMember = {
  userId: string
  name: string
  githubLogin: string | null
  /** GitHub's membership state, 'pending' until the invitation is accepted. */
  membershipState: string | null
}

/** The least a row needs for these helpers; the table's full row type extends it. */
export type RowLike = {
  id: string
  who: string
  githubLogin: string | null
  fullName: string | null
  /** The team's members for a team repository; empty for an individual one. */
  members: RowMember[]
}

export type StudentRow<R extends RowLike> = {
  /** Unique across the expanded table: a member can only be on one team per assignment. */
  key: string
  /** The repository this row was expanded from; its status and score are the team's. */
  repo: R
  /** Null for a team that has no members yet. */
  member: RowMember | null
}

/**
 * One row per team member, in roster order, so staff can scan for a name.
 *
 * A team with no members still gets a row: hiding it would make a repository
 * disappear from the table depending on which view is selected, which is the
 * kind of thing that gets reported as a lost repository.
 */
export function byStudent<R extends RowLike>(repos: R[]): StudentRow<R>[] {
  const rows: StudentRow<R>[] = []
  for (const repo of repos) {
    if (repo.members.length === 0) {
      rows.push({ key: repo.id, repo, member: null })
      continue
    }
    for (const member of repo.members) {
      rows.push({ key: `${repo.id}:${member.userId}`, repo, member })
    }
  }
  return rows.sort((a, b) => {
    const an = a.member?.name ?? a.repo.who
    const bn = b.member?.name ?? b.repo.who
    return an.localeCompare(bn, 'en', { sensitivity: 'base' })
  })
}

/** Case-insensitive substring match on the team or student, their login, the repository, or any member. */
export function matchesQuery(repo: RowLike, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    repo.who,
    repo.githubLogin,
    repo.fullName,
    ...repo.members.flatMap((m) => [m.name, m.githubLogin]),
  ]
  return haystack.some((v) => v !== null && v.toLowerCase().includes(q))
}

/** The student view filters per member, so a search for Ava shows Ava's row, not her whole team. */
export function studentRowMatches<R extends RowLike>(row: StudentRow<R>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const own = [row.repo.who, row.repo.fullName, row.member?.name, row.member?.githubLogin]
  return own.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
}
