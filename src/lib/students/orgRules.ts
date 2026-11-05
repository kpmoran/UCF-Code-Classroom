/**
 * The decisions behind student organization membership, kept pure so each one is
 * unit tested. The GitHub calls that act on them are in orgAccess.ts.
 */

/**
 * `removed` is the end of a term: the classroom took them out of the organization,
 * or turned them into an outside collaborator, and will not invite them again.
 */
export type OrgState = 'pending' | 'active' | 'expired' | 'failed' | 'removed'

/** GitHub expires an organization invitation after seven days. */
export const ORG_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The team a classroom's students are invited through.
 *
 * Named like the staff team, for the same reason: an organization hosting several
 * courses has several of these and someone has to tell them apart on GitHub.
 */
export function studentTeamName(classroom: {
  name: string
  courseCode: string | null
  term: string | null
}): string {
  const label = [classroom.courseCode, classroom.term].filter(Boolean).join('-')
  return `${label || classroom.name}-students`
}

/**
 * Why the organization is not safe to make students members of, or null when it is.
 *
 * Base permission is the one that matters, twice over. Anything above "No
 * permission" lets every student read every other student's private repository. And
 * at "Write" or above, deadline locks stop holding: a lock lowers the student's
 * direct permission to read-only, but GitHub grants the highest access from any
 * source, so the organization's base permission would keep them pushing while the
 * app reports the repository as locked.
 *
 * An unknown base permission is not treated as a problem. It means the App could not
 * read the setting, and refusing on that basis would switch the feature off for a
 * correctly configured organization; the settings page says it could not check.
 */
export function orgAccessProblem(settings: {
  baseRepositoryPermission: string | null
}): string | null {
  const base = settings.baseRepositoryPermission
  if (base === null || base === 'none') return null
  return (
    `The organization's base repository permission is "${base}". Students who join ` +
    'it would be able to read every other student’s repository' +
    (base === 'read' ? '' : ', and deadline locks would not hold') +
    '. Set it to "No permission" in the organization’s Member privileges settings.'
  )
}

/**
 * The state to show, allowing for an invitation GitHub has since expired.
 *
 * A pending invitation older than its lifetime is reported as expired without asking
 * GitHub, so the instructor's table shows who needs a new one even before anybody
 * re-checks.
 */
export function effectiveOrgState(
  state: string | null,
  invitedAt: Date | null,
  now: Date,
): OrgState | null {
  if (state === 'pending' && invitedAt) {
    return now.getTime() - invitedAt.getTime() > ORG_INVITATION_LIFETIME_MS ? 'expired' : 'pending'
  }
  if (
    state === 'pending' ||
    state === 'active' ||
    state === 'expired' ||
    state === 'failed' ||
    state === 'removed'
  ) {
    return state
  }
  return null
}

export type OrgRemovalDecision =
  | { remove: true }
  | { remove: false; reason: string }

/**
 * Whether a student may be taken out of the organization at the end of a term.
 *
 * Every refusal protects someone whose membership this classroom does not own:
 *
 *   - They were a member before the classroom invited them — a lab member, a TA in
 *     another course, a returning student from a previous term.
 *   - They are an organization owner.
 *   - Another classroom still needs them there: staff anywhere in the organization,
 *     or a student in another active classroom that grants membership.
 */
export function decideOrgRemoval(input: {
  joinedViaClassroom: boolean
  orgRole: string | null
  staffInAnotherClassroom: boolean
  studentInAnotherActiveClassroom: boolean
}): OrgRemovalDecision {
  if (!input.joinedViaClassroom) {
    return { remove: false, reason: 'was already a member before this classroom invited them' }
  }
  if (input.orgRole === 'admin') {
    return { remove: false, reason: 'is an organization owner' }
  }
  if (input.staffInAnotherClassroom) {
    return { remove: false, reason: 'is staff in another classroom in this organization' }
  }
  if (input.studentInAnotherActiveClassroom) {
    return { remove: false, reason: 'is still a student in another active classroom here' }
  }
  return { remove: true }
}
