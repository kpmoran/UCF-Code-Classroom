import type { TeamConstraints } from './rules'

/**
 * Copying teams from one group assignment to another.
 *
 * A semester-long project is several assignments with the same teams, and
 * recreating them by hand — one name, then one move per student — is the kind of
 * chore that gets done wrong at 11pm. The plan is computed here, pure, so the
 * refusals and the skips can be tested without a database; the action applies it.
 */

export type SourceTeam = {
  name: string
  members: Array<{ userId: string; role: 'LEADER' | 'MEMBER' }>
}

export type PlannedTeam = {
  name: string
  members: Array<{ userId: string; role: 'LEADER' | 'MEMBER' }>
}

export type SkippedMember = {
  userId: string
  /** The source team they were on, so the instructor knows where the gap is. */
  team: string
}

export type CopyPlan =
  | { ok: true; teams: PlannedTeam[]; skipped: SkippedMember[] }
  | { ok: false; reason: string }

/**
 * Decide what a copy would create, or why it cannot.
 *
 * Every refusal is a whole-copy refusal: a half-copied set of teams would leave
 * the instructor working out which half, which is worse than the chore it saves.
 *
 * `eligible` is the set of users who may be placed on a team — the students still
 * claimed on the roster. Anyone else on a source team is skipped and reported,
 * not silently dropped: a student who left the course should not reappear, and a
 * student the instructor expected to see should not vanish without a word.
 */
export function planTeamCopy({
  source,
  existingNames,
  constraints,
  eligible,
  slugify,
}: {
  source: SourceTeam[]
  /** Names already on the target assignment. */
  existingNames: readonly string[]
  constraints: TeamConstraints
  eligible: ReadonlySet<string>
  slugify: (value: string) => string
}): CopyPlan {
  if (source.length === 0) {
    return { ok: false, reason: 'That assignment has no teams to copy.' }
  }

  // Into an empty assignment only. Merging into existing teams raises questions
  // (clashing names, students already placed) that have no answer the instructor
  // did not choose, so they choose by starting from nothing.
  if (existingNames.length > 0) {
    return {
      ok: false,
      reason:
        'This assignment already has teams. Teams can only be copied into an assignment ' +
        'that has none yet.',
    }
  }

  if (constraints.maxTeams !== null && source.length > constraints.maxTeams) {
    return {
      ok: false,
      reason:
        `That assignment has ${source.length} teams, but this one allows at most ` +
        `${constraints.maxTeams}. Raise the limit in this assignment’s settings first.`,
    }
  }

  const teams: PlannedTeam[] = []
  const skipped: SkippedMember[] = []
  const seenSlugs = new Set<string>()

  for (const team of source) {
    const slug = slugify(team.name)
    // Source names are already distinct by slug — the rules enforce that on
    // creation — but a defensive check costs nothing and a duplicate would fail
    // later as a confusing GitHub team collision.
    if (seenSlugs.has(slug)) {
      return {
        ok: false,
        reason: `Two teams in that assignment would share the GitHub name “${slug}”. Rename one first.`,
      }
    }
    seenSlugs.add(slug)

    const members = team.members.filter((m) => {
      if (eligible.has(m.userId)) return true
      skipped.push({ userId: m.userId, team: team.name })
      return false
    })

    if (constraints.maxTeamSize !== null && members.length > constraints.maxTeamSize) {
      return {
        ok: false,
        reason:
          `Team “${team.name}” has ${members.length} members, but this assignment allows ` +
          `at most ${constraints.maxTeamSize} per team. Raise the limit in this ` +
          'assignment’s settings first.',
      }
    }

    teams.push({ name: team.name, members })
  }

  return { ok: true, teams, skipped }
}
