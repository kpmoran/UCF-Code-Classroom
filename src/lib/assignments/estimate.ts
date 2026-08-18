/**
 * Provisioning cost estimation.
 *
 * Kept out of `actions.ts` because a `'use server'` module may only export async
 * functions — exporting this synchronous helper from there is a build error, and
 * one that neither `tsc` nor ESLint reports.
 */

/**
 * How many content-creating GitHub calls one repository costs.
 *
 * Used to give an honest ETA before a bulk provision, so a long-running job is
 * not mistaken for a hung one. Generating the repository and inviting the
 * collaborator are always needed; a feedback pull request adds a ref plus the PR
 * itself, and autograding adds the workflow file commit.
 */
export function callsPerRepo(opts: { feedbackPr: boolean; autograde: boolean }): number {
  return 2 + (opts.feedbackPr ? 2 : 0) + (opts.autograde ? 1 : 0)
}
