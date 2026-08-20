import 'server-only'

import { githubMutate, githubRead } from '../app'
import { GitHubDomainError } from '../errors'

/**
 * File and ref operations, used to inject the autograding workflow and to build
 * the feedback pull request.
 */

/**
 * Create or update a file. Idempotent: the existing blob SHA is fetched first,
 * which is what GitHub requires for an update and what makes a retry safe.
 */
export async function putFile(
  installationId: bigint,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
): Promise<{ commitSha: string | null; changed: boolean }> {
  const existing = await getFile(installationId, owner, repo, path, branch)

  // Skip the write when the content already matches, so re-running provisioning
  // does not litter student history with empty "update workflow" commits.
  if (existing && existing.content === content) {
    return { commitSha: null, changed: false }
  }

  const data = await githubMutate(
    `put file ${path} in repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.rest.repos
        .createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          sha: existing?.sha,
          branch,
        })
        .then((r) => r.data),
  )

  return { commitSha: data.commit.sha ?? null, changed: true }
}

export async function getFile(
  installationId: bigint,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ sha: string; content: string } | null> {
  try {
    const data = await githubRead(
      `get file ${path} in repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.repos.getContent({ owner, repo, path, ref }).then((r) => r.data),
    )

    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return null
    }

    return {
      sha: data.sha,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
    }
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw error
  }
}

/**
 * The SHA of the *first* commit on a branch.
 *
 * This is the anchor for the feedback pull request: pinning the PR's base branch
 * here means the diff always shows everything the student has written, because
 * the base never moves. Getting this wrong (using the current head) produces an
 * empty feedback PR, which is the classic way this feature fails.
 */
export async function getInitialCommitSha(
  installationId: bigint,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const commits = await githubRead(
    `list commits on branch ${branch} of repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.paginate(octokit.rest.repos.listCommits, {
        owner,
        repo,
        sha: branch,
        per_page: 100,
      }),
  )

  if (commits.length === 0) return null
  // listCommits is newest-first, so the initial commit is last.
  return commits[commits.length - 1].sha
}

/** Create a branch at a specific commit. Returns false if it already exists. */
export async function createBranch(
  installationId: bigint,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<boolean> {
  const existing = await getRef(installationId, owner, repo, `heads/${branch}`)
  if (existing) return false

  await githubMutate(
    `create ref ${branch} in repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha }),
  )
  return true
}

export async function getRef(
  installationId: bigint,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ sha: string } | null> {
  try {
    const data = await githubRead(
      `get ref ${ref} in repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.git.getRef({ owner, repo, ref }).then((r) => r.data),
    )
    return { sha: data.object.sha }
  } catch (error) {
    /*
     * 404 is "no such ref". 409 is "Git Repository is empty", which the git refs
     * endpoint returns instead of 404 when the repository has no commits at all — a
     * distinction that only surfaced once assignments could start from nothing.
     * Both mean the same thing to every caller: there is no ref to read.
     */
    if (error instanceof GitHubDomainError && (error.status === 404 || error.status === 409)) {
      return null
    }
    throw error
  }
}
