/**
 * Which rows one workflow run is recorded against.
 *
 * A GitHub repository can belong to more than one `assignment_repos` row: an
 * individual assignment whose students were each assigned the same existing
 * repository, and — because nothing prevents it — two assignments pointing at the
 * same repository across a course.
 *
 * Results describe the repository, so they belong to every row that is genuinely
 * grading it. Pure and separated from the job because getting this wrong is quiet:
 * too few rows and a student silently has no grade, too many and a run leaks into an
 * assignment that never asked for one.
 */

export type FanoutCandidate = {
  id: string
  fullName: string | null
  assignment: { autogradeEnabled: boolean }
}

/**
 * Rows that should receive this run.
 *
 * Two filters, both load-bearing:
 *
 *  - **A row with no `fullName` is not provisioned yet.** There is no repository to
 *    attribute anything to, and writing a score against it would claim otherwise.
 *  - **A row whose assignment has autograding off is excluded.** Phase 1 of a project
 *    may grade automatically while phase 2 is marked by hand; a run triggered by
 *    phase 1's workflow must not appear as a phase 2 grade.
 */
export function selectAutogradeTargets<T extends FanoutCandidate>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => row.fullName !== null && row.assignment.autogradeEnabled)
}

/**
 * Whether ingestion can be skipped outright.
 *
 * Only when *every* target already has the run completed. A repository shared by
 * three students whose ingestion died after the first write must finish the other two
 * on retry, rather than find one COMPLETED row and conclude there is nothing to do.
 */
export function alreadyFullyIngested(input: {
  targetCount: number
  completedCount: number
}): boolean {
  if (input.targetCount === 0) return true
  return input.completedCount >= input.targetCount
}
