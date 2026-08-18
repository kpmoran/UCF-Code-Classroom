/**
 * Team formation rules.
 *
 * Pure so the constraints can be tested exhaustively without a database. Each
 * function returns a *reason* rather than a boolean, because every one of these
 * refusals is shown to a student who needs to know what to do instead.
 */

export type TeamConstraints = {
  /** Null means unlimited. */
  maxTeams: number | null
  maxTeamSize: number | null
  teamNamingMode: 'STUDENT_CHOSEN' | 'INSTRUCTOR_ASSIGNED'
}

export type TeamSnapshot = {
  id: string
  name: string
  memberCount: number
  /** True once a GitHub repository exists for this team. */
  hasRepo: boolean
}

export type RuleResult = { allowed: true } | { allowed: false; reason: string }

const ALLOWED = { allowed: true } as const

const MIN_NAME = 2
const MAX_NAME = 60

/**
 * Validate a student-supplied team name.
 *
 * The name becomes part of a GitHub repository name and a GitHub team slug, so it
 * must survive sanitisation to something non-empty — otherwise two teams whose
 * names differ only in punctuation would collide.
 */
export function validateTeamName(
  rawName: string,
  existingNames: readonly string[],
  slugify: (value: string) => string,
): RuleResult {
  const name = rawName.trim()

  if (name.length < MIN_NAME) {
    return { allowed: false, reason: `Team names need at least ${MIN_NAME} characters.` }
  }
  if (name.length > MAX_NAME) {
    return { allowed: false, reason: `Keep team names under ${MAX_NAME} characters.` }
  }

  const slug = slugify(name)
  if (!slug) {
    return {
      allowed: false,
      reason:
        'That name has no letters or numbers GitHub can use. Add some Latin letters or digits.',
    }
  }

  // Compared by slug, not by raw text: "The Knights" and "the-knights" would
  // otherwise both be accepted and then fight over one GitHub team.
  const clash = existingNames.find((existing) => slugify(existing) === slug)
  if (clash) {
    return {
      allowed: false,
      reason:
        clash.trim().toLowerCase() === name.toLowerCase()
          ? `A team called “${clash}” already exists. Join it, or pick another name.`
          : `That is too close to the existing team “${clash}” — they would share one GitHub team. Pick another name.`,
    }
  }

  return ALLOWED
}

/** Whether another team may be created. */
export function canCreateTeam(
  constraints: TeamConstraints,
  currentTeamCount: number,
  actor: 'STUDENT' | 'STAFF',
): RuleResult {
  if (constraints.teamNamingMode === 'INSTRUCTOR_ASSIGNED' && actor === 'STUDENT') {
    return {
      allowed: false,
      reason: 'Your instructor assigns teams for this assignment, so you cannot create one.',
    }
  }

  if (constraints.maxTeams !== null && currentTeamCount >= constraints.maxTeams) {
    return {
      allowed: false,
      reason:
        `This assignment allows at most ${constraints.maxTeams} teams, and they all exist ` +
        'already. Join one of them, or ask your instructor to raise the limit.',
    }
  }

  return ALLOWED
}

/** Whether a student may join a specific team. */
export function canJoinTeam(
  constraints: TeamConstraints,
  team: TeamSnapshot,
  currentTeamOfStudent: TeamSnapshot | null,
): RuleResult {
  if (currentTeamOfStudent?.id === team.id) {
    return { allowed: false, reason: `You are already on ${team.name}.` }
  }

  if (currentTeamOfStudent) {
    return {
      allowed: false,
      reason:
        `You are already on ${currentTeamOfStudent.name}. Leave that team first, or ask your ` +
        'instructor to move you.',
    }
  }

  if (constraints.maxTeamSize !== null && team.memberCount >= constraints.maxTeamSize) {
    return {
      allowed: false,
      reason: `${team.name} is full (${constraints.maxTeamSize} members). Join another team.`,
    }
  }

  return ALLOWED
}

/**
 * Whether a student may leave their team.
 *
 * Leaving after the repository exists is refused: the student's commits are
 * already in it, and quietly revoking their access would look like data loss to
 * them and like a missing contribution to the instructor. An instructor can still
 * move someone deliberately.
 */
export function canLeaveTeam(team: TeamSnapshot, actor: 'STUDENT' | 'STAFF'): RuleResult {
  if (actor === 'STAFF') return ALLOWED

  if (team.hasRepo) {
    return {
      allowed: false,
      reason:
        `${team.name} already has a repository, so you cannot leave on your own. Ask your ` +
        'instructor to move you if you are on the wrong team.',
    }
  }

  return ALLOWED
}

/**
 * Whether a team is ready for its repository to be provisioned.
 *
 * Deliberately permits a team of one: a student who forms a team early and
 * recruits later should still be able to start work, and requiring a full team
 * would block the whole class on its slowest members.
 */
export function canProvisionTeam(team: TeamSnapshot): RuleResult {
  if (team.memberCount < 1) {
    return { allowed: false, reason: 'A team needs at least one member before it gets a repository.' }
  }
  if (team.hasRepo) {
    return { allowed: false, reason: `${team.name} already has a repository.` }
  }
  return ALLOWED
}

/** Human summary of the constraints, for the team formation UI. */
export function describeConstraints(constraints: TeamConstraints): string {
  const parts: string[] = []
  if (constraints.maxTeams !== null) parts.push(`at most ${constraints.maxTeams} teams`)
  if (constraints.maxTeamSize !== null) {
    parts.push(`up to ${constraints.maxTeamSize} members per team`)
  }
  if (parts.length === 0) return 'No limit on teams or team size.'
  return `${parts.join(', ')}.`
}
