import 'server-only'

import { githubMutate, githubRead } from '../app'
import { GitHubDomainError } from '../errors'

import { createBranch, getRef } from './contents'
import { getRepoHead } from './repos'

/**
 * Feedback pull requests.
 *
 * The mechanism, which is the same one GitHub Classroom uses:
 *
 *   1. Pin a `feedback` branch at the assignment's **starting state**.
 *   2. Open a PR with head = default branch, base = `feedback`.
 *
 * Because the base never moves, the PR diff always shows the student's complete
 * work and keeps growing as they push. Pinning the base is the part that is easy
 * to get wrong — basing the PR on the moving default branch yields a permanently
 * empty diff.
 *
 * **What counts as the starting state matters.** It is the head *after* this app
 * finishes setting the repository up, not the template's first commit. Autograding
 * injection adds a workflow and a manifest, and pinning behind those would make
 * every feedback PR open with our own files shown as student changes — noise on
 * every single submission. So the branch is created at the end of provisioning,
 * at whatever the head is then.
 *
 * Creating the branch and opening the PR are separate steps because they happen at
 * different times: the branch is pinned during provisioning, but GitHub refuses a
 * pull request with no commits between base and head, so the PR itself can only be
 * opened once the student has pushed something.
 */

export const FEEDBACK_BRANCH = 'feedback'

/**
 * Pin the feedback branch at the current head of the default branch.
 *
 * Idempotent, and deliberately non-destructive: an existing `feedback` ref is left
 * exactly where it is. Moving it forward later would silently shrink every diff and
 * hide work the instructor had already been reviewing.
 */
export async function ensureFeedbackBranch(
  installationId: bigint,
  owner: string,
  repo: string,
  /*
   * The commit to pin the baseline at, when the caller knows it.
   *
   * Provisioning does: it has just written the autograding workflow and holds the sha
   * of that commit. Passing it avoids a read that GitHub can answer with a stale ref
   * — refs are eventually consistent, and a stale answer here pins the baseline
   * *before* the injected files, which then appear as student changes in every
   * feedback diff for the life of the assignment. Rare, load-dependent, and permanent
   * once it happens, because the branch is only ever created once.
   *
   * Omitted by the sweep and the webhook path, which run long after the writes have
   * settled and have no particular commit in mind.
   */
  baseSha?: string | null,
): Promise<{ state: 'created' | 'existing' | 'skipped'; sha: string | null; reason?: string }> {
  const existing = await getRef(installationId, owner, repo, `heads/${FEEDBACK_BRANCH}`)
  if (existing) return { state: 'existing', sha: existing.sha }

  if (baseSha) {
    try {
      await createBranch(installationId, owner, repo, FEEDBACK_BRANCH, baseSha)
      return { state: 'created', sha: baseSha }
    } catch (error) {
      /*
       * Falling back rather than failing, because the two outcomes are not
       * comparable. Pinning at a slightly stale head produces a feedback diff with
       * two of our files in it — untidy, and what this whole path exists to avoid.
       * Creating no branch at all means the student never gets a feedback pull
       * request, which is the feature not working.
       *
       * So a refusal here (GitHub can reject a ref pointing at a commit it has not
       * finished making visible) drops through to the head read below, which is what
       * this did before the sha was threaded through at all.
       */
      console.warn(
        `[github] could not pin the feedback baseline of ${owner}/${repo} at ${baseSha}; ` +
          `falling back to the branch head: ${
            error instanceof GitHubDomainError ? error.userMessage : String(error)
          }`,
      )
    }
  }

  const head = await getRepoHead(installationId, owner, repo)
  if (!head) {
    // An empty repository — a template with no commits. There is nothing to pin.
    return {
      state: 'skipped',
      sha: null,
      reason: 'The repository has no commits yet, so no feedback baseline could be recorded.',
    }
  }

  await createBranch(installationId, owner, repo, FEEDBACK_BRANCH, head.sha)
  return { state: 'created', sha: head.sha }
}

export type FeedbackPrResult =
  | { state: 'created' | 'existing'; number: number; htmlUrl: string }
  | { state: 'skipped'; reason: string }

/**
 * Open the feedback pull request, if there is anything to review yet.
 *
 * Returns `skipped` — not an error — when the student has pushed nothing beyond the
 * starting state. That is the normal condition immediately after they accept, and
 * treating it as a failure would fill the instructor's screen with red for every
 * student who has not started.
 */
export async function ensureFeedbackPullRequest(
  installationId: bigint,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<FeedbackPrResult> {
  const existing = await findFeedbackPr(installationId, owner, repo)
  if (existing) return { state: 'existing', ...existing }

  const branch = await ensureFeedbackBranch(installationId, owner, repo)
  if (branch.state === 'skipped') {
    return { state: 'skipped', reason: branch.reason ?? 'No feedback baseline could be recorded.' }
  }

  try {
    const data = await githubMutate(
      `create feedback pull request in repo ${owner}/${repo}`,
      installationId,
      (octokit) =>
        octokit.rest.pulls
          .create({
            owner,
            repo,
            title: 'Feedback',
            head: defaultBranch,
            base: FEEDBACK_BRANCH,
            body:
              'This pull request collects instructor feedback on your work.\n\n' +
              'Its base is pinned to the starting state of the assignment, so the diff shows ' +
              'everything you have added. Do not merge or close it — leave it open for the ' +
              'whole assignment. Reply to comments here.',
            maintainer_can_modify: false,
          })
          .then((r) => r.data),
    )

    return { state: 'created', number: data.number, htmlUrl: data.html_url }
  } catch (error) {
    // GitHub reports "No commits between" in `errors[]`, not the top-level message
    // — see toDomainError, which folds those in so this check works.
    if (
      error instanceof GitHubDomainError &&
      error.status === 422 &&
      [error.message, ...error.details].some((text) => /no commits between/i.test(text))
    ) {
      return {
        state: 'skipped',
        reason:
          'No commits yet beyond the starting state, so there is nothing to review. The ' +
          'feedback pull request opens automatically once the student pushes.',
      }
    }
    throw error
  }
}

async function findFeedbackPr(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  const pulls = await githubRead(
    `list pull requests in repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        // Includes closed PRs: a student who closes the feedback PR must not cause
        // a second one to be opened alongside it.
        state: 'all',
        base: FEEDBACK_BRANCH,
        per_page: 100,
      }),
  )

  const match = pulls.find((p) => p.base.ref === FEEDBACK_BRANCH)
  return match ? { number: match.number, htmlUrl: match.html_url } : null
}
