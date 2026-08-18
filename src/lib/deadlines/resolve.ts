/**
 * Deadline resolution.
 *
 * Pure, because every interesting case here is a boundary condition — a deadline
 * exactly now, an extension that moved a deadline *earlier*, a repository locked
 * before an extension was granted — and those are far easier to get right against
 * a table of examples than against a live database.
 */

export type DeadlineInput = {
  /** The assignment's deadline, or null for no deadline. */
  assignmentDeadline: Date | null
  /** A per-student or per-team override, or null. */
  extensionDeadline: Date | null
  lockOnDeadline: boolean
}

export type RepoDeadlineState = {
  /** When write access was withdrawn, or null if it is not locked. */
  lockedAt: Date | null
  /** Head commit captured at the deadline, or null if not captured yet. */
  deadlineSha: string | null
  /** Most recent push, if known. */
  lastPushedAt: Date | null
}

/**
 * The deadline that actually applies.
 *
 * An extension always wins, even one that moves the deadline *earlier*: an
 * instructor who sets an earlier date for one student has done so deliberately,
 * and silently ignoring it would be worse than honouring it.
 */
export function effectiveDeadline(input: DeadlineInput): Date | null {
  return input.extensionDeadline ?? input.assignmentDeadline
}

/** Whether the effective deadline has passed at `now`. */
export function isPastDeadline(input: DeadlineInput, now: Date): boolean {
  const deadline = effectiveDeadline(input)
  if (!deadline) return false
  // A deadline of exactly `now` counts as passed: "due at 23:59" means work
  // submitted at 23:59:00.000 is on time, and anything after is not.
  return now.getTime() >= deadline.getTime()
}

/**
 * Whether a submission is late.
 *
 * Based on the last push rather than on the current time, so an assignment that
 * was submitted on time does not become "late" merely because the deadline has
 * since passed.
 */
export function isLateSubmission(
  input: DeadlineInput,
  state: Pick<RepoDeadlineState, 'lastPushedAt'>,
): boolean {
  const deadline = effectiveDeadline(input)
  if (!deadline || !state.lastPushedAt) return false
  return state.lastPushedAt.getTime() > deadline.getTime()
}

export type DeadlineAction =
  | { kind: 'none' }
  | { kind: 'capture'; reason: string }
  | { kind: 'lock'; reason: string }
  | { kind: 'capture-and-lock'; reason: string }
  | { kind: 'unlock'; reason: string }

/**
 * What the deadline sweep should do to one repository.
 *
 * Deliberately expressed as a decision function rather than inline conditionals
 * in the job, so the whole truth table is visible and testable in one place.
 *
 * Two behaviours are worth stating explicitly:
 *
 *  - **Capture happens whether or not locking is enabled.** Recording the head
 *    commit at the deadline is what lets an instructor grade the on-time state
 *    while still allowing students to keep working, which is the common
 *    arrangement.
 *  - **An extension unlocks.** Granting more time to a student whose repository
 *    was already locked must restore write access, otherwise the extension is
 *    meaningless.
 */
export function decideDeadlineAction(
  input: DeadlineInput,
  state: RepoDeadlineState,
  now: Date,
): DeadlineAction {
  const deadline = effectiveDeadline(input)

  // No deadline at all: nothing to enforce, but a repository locked by a
  // previously-set deadline must be released.
  if (!deadline) {
    return state.lockedAt
      ? { kind: 'unlock', reason: 'The deadline was removed.' }
      : { kind: 'none' }
  }

  const passed = now.getTime() >= deadline.getTime()

  if (!passed) {
    // Before the deadline. Only interesting if we locked too early — which is
    // exactly what an extension granted after locking looks like.
    return state.lockedAt
      ? { kind: 'unlock', reason: 'The deadline was extended.' }
      : { kind: 'none' }
  }

  const needsCapture = state.deadlineSha === null
  const needsLock = input.lockOnDeadline && state.lockedAt === null

  if (needsCapture && needsLock) {
    return {
      kind: 'capture-and-lock',
      reason: 'The deadline passed: recording the submitted commit and revoking write access.',
    }
  }
  if (needsCapture) {
    return { kind: 'capture', reason: 'The deadline passed: recording the submitted commit.' }
  }
  if (needsLock) {
    return { kind: 'lock', reason: 'The deadline passed: revoking write access.' }
  }

  // Past the deadline, already captured, and either locked or not meant to be.
  // One case remains: locking was turned off after a repository was locked.
  if (!input.lockOnDeadline && state.lockedAt) {
    return { kind: 'unlock', reason: 'Locking at the deadline was turned off.' }
  }

  return { kind: 'none' }
}

/** Short human label for a deadline, for tables and badges. */
export function describeDeadline(
  input: DeadlineInput,
  state: Pick<RepoDeadlineState, 'lastPushedAt'>,
  now: Date,
): { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' } {
  const deadline = effectiveDeadline(input)
  if (!deadline) return { label: 'No deadline', tone: 'neutral' }

  const extended = input.extensionDeadline !== null
  const prefix = extended ? 'Extended to' : 'Due'

  if (isLateSubmission(input, state)) {
    return { label: 'Submitted late', tone: 'danger' }
  }

  if (now.getTime() >= deadline.getTime()) {
    return { label: extended ? 'Extension expired' : 'Past due', tone: 'warning' }
  }

  const hoursLeft = (deadline.getTime() - now.getTime()) / 3_600_000
  if (hoursLeft <= 24) {
    return {
      label: `${prefix} in ${hoursLeft < 1 ? 'under an hour' : `${Math.round(hoursLeft)} hours`}`,
      tone: 'warning',
    }
  }

  return { label: `${prefix} ${deadline.toLocaleDateString('en-US')}`, tone: 'success' }
}
