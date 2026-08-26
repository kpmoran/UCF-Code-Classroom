import { effectiveDeadline, isLateSubmission, type DeadlineInput } from './resolve'

/**
 * One repository's deadline state, in the shape a page can hand to a client
 * component.
 *
 * Extracted because three views need the same answer — the staff table, the
 * individual student panel and the team panel — and lateness is not a property of
 * the assignment but of the student: an extension moves their deadline, so the
 * calculation has to happen per repository. Three inline copies of that would be
 * three chances for a student's own page to disagree with their instructor's about
 * whether they were late.
 */
export type SubmissionSummary = {
  /**
   * The commit recorded at the deadline.
   *
   * Three meanings, deliberately not collapsed: `null` is "not captured yet" — the
   * deadline has not passed, or the sweep has not reached it. A sha is the commit
   * that would be graded. The empty string is "captured, and there was nothing" —
   * a repository with no commit dated before the deadline, which is what an
   * assignment accepted after the deadline looks like.
   */
  sha: string | null
  late: boolean
  locked: boolean
  extended: boolean
  /** The deadline that actually applies, after any extension. */
  deadline: string | null
}

export function summarizeSubmission(
  input: DeadlineInput,
  repo: {
    deadlineSha: string | null
    lockedAt: Date | null
    lastPushedAt: Date | null
  },
): SubmissionSummary {
  const effective = effectiveDeadline(input)

  return {
    sha: repo.deadlineSha,
    late: isLateSubmission(input, { lastPushedAt: repo.lastPushedAt }),
    locked: repo.lockedAt !== null,
    extended: input.extensionDeadline !== null,
    deadline: effective ? effective.toISOString() : null,
  }
}
