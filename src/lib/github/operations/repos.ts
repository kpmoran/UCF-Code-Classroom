import 'server-only'

import { githubMutate, githubRead } from '../app'
import { GitHubDomainError, toDomainError } from '../errors'

/**
 * Repository operations.
 *
 * Every mutation here is idempotent: a provisioning job that dies halfway and is
 * retried must converge on the same repository rather than create a second one
 * or fail permanently. That is why each one checks for the existing resource
 * first, even though it costs a read.
 */

export type RepoSummary = {
  id: bigint
  name: string
  fullName: string
  htmlUrl: string
  private: boolean
  isTemplate: boolean
  defaultBranch: string
  pushedAt: string | null
}

function toSummary(repo: {
  id: number
  name: string
  full_name: string
  html_url: string
  private: boolean
  is_template?: boolean
  default_branch?: string
  pushed_at?: string | null
}): RepoSummary {
  return {
    id: BigInt(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    private: repo.private,
    isTemplate: repo.is_template ?? false,
    defaultBranch: repo.default_branch ?? 'main',
    pushedAt: repo.pushed_at ?? null,
  }
}

/** A repository, or null when it does not exist. */
export async function getRepo(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<RepoSummary | null> {
  try {
    const data = await githubRead(
      `get repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.repos.get({ owner, repo }).then((r) => r.data),
    )
    return toSummary(data)
  } catch (error) {
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw error
  }
}

/**
 * Repositories in the org that are marked as templates.
 *
 * Asks the search API to do the filtering, because the obvious implementation —
 * page through every repository and keep the templates — costs one request per
 * hundred repositories, and a classroom organization gains a repository per
 * student per assignment. A course that runs two sections for a year is several
 * sequential round trips just to populate one dropdown, and it gets slower every
 * time the app is used, which is the wrong direction for a cost to move in.
 *
 * Verified against a real installation: `template:true` returns **private**
 * templates for an installation token, which is the case that matters here since
 * course templates usually are private.
 *
 * Search is a different subsystem with its own rate limit and its own index, so
 * the exhaustive listing stays as a fallback. The index can also lag repository
 * creation by a few seconds, so a template made moments ago may not appear yet —
 * acceptable, because the field takes free text and never depended on this list.
 */
export async function listTemplateRepos(
  installationId: bigint,
  org: string,
): Promise<RepoSummary[]> {
  try {
    const found = await githubRead(`search templates in ${org}`, installationId, (octokit) =>
      octokit.paginate(octokit.rest.search.repos, {
        q: `org:${org} template:true`,
        per_page: 100,
      }),
    )
    // Trust the flag on the record rather than the query, so a search-syntax
    // change cannot quietly turn this into "every repository in the org".
    return found.map(toSummary).filter((r) => r.isTemplate)
  } catch {
    return listTemplateReposByPaging(installationId, org)
  }
}

/** The exhaustive fallback: every repository in the org, filtered locally. */
async function listTemplateReposByPaging(
  installationId: bigint,
  org: string,
): Promise<RepoSummary[]> {
  const repos = await githubRead(`list repos for org ${org}`, installationId, (octokit) =>
    octokit.paginate(octokit.rest.repos.listForOrg, { org, per_page: 100, sort: 'updated' }),
  )
  return repos.map(toSummary).filter((r) => r.isTemplate)
}

/** Every repository name in the org, for collision-free naming. */
export async function listOrgRepoNames(
  installationId: bigint,
  org: string,
): Promise<Set<string>> {
  const repos = await githubRead(`list repos for org ${org}`, installationId, (octokit) =>
    octokit.paginate(octokit.rest.repos.listForOrg, { org, per_page: 100 }),
  )
  return new Set(repos.map((r) => r.name.toLowerCase()))
}

/**
 * Verify a template repository is usable before an assignment is created,
 * so the failure surfaces in the create form rather than in 200 queued jobs.
 */
export async function validateTemplate(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<{ ok: true; template: RepoSummary } | { ok: false; reason: string }> {
  const found = await getRepo(installationId, owner, repo)

  if (!found) {
    return {
      ok: false,
      reason:
        `Could not find ${owner}/${repo}. Check the spelling, and confirm the ` +
        'UCF-Code-Connect app has access to that repository.',
    }
  }

  if (!found.isTemplate) {
    return {
      ok: false,
      reason:
        `${found.fullName} exists but is not marked as a template. Open its GitHub ` +
        'settings and tick “Template repository”.',
    }
  }

  return { ok: true, template: found }
}

/**
 * Wait until a freshly generated repository actually has content.
 *
 * `POST /repos/.../generate` is **asynchronous**: it returns a full repository
 * object while GitHub is still copying the template in the background. Measured
 * against a real org, the response came back at ~1.8s but the tree was not
 * readable until ~3.8s, with reads failing as `404 This repository is empty` and
 * ref lookups as `409 Git Repository is empty`.
 *
 * Without this wait, everything that immediately follows generation — injecting
 * the autograding workflow, reading the initial commit, pinning the feedback
 * branch — fails intermittently and for every student on a slow day. Polling
 * uses unmetered reads, so it costs no content budget.
 */
export async function waitForRepoContent(
  installationId: bigint,
  owner: string,
  repo: string,
  timeoutMs = 60_000,
): Promise<{ ready: boolean; waitedMs: number }> {
  const started = Date.now()
  let delayMs = 400

  while (Date.now() - started < timeoutMs) {
    const head = await getRepoHead(installationId, owner, repo)
    if (head) return { ready: true, waitedMs: Date.now() - started }

    await new Promise((resolve) => setTimeout(resolve, delayMs))
    // Gentle backoff, capped so a slow copy is still noticed promptly.
    delayMs = Math.min(delayMs * 1.5, 3_000)
  }

  return { ready: false, waitedMs: Date.now() - started }
}

export type GenerateRepoInput = {
  installationId: bigint
  templateOwner: string
  templateRepo: string
  owner: string
  name: string
  private: boolean
  description?: string
}

/**
 * Create a repository from a template.
 *
 * Idempotent by pre-check: if `owner/name` already exists we return it rather
 * than letting GitHub 422. This is the single most important retry path in the
 * app — without it, a worker crash between repo creation and the database write
 * leaves an orphaned repo that blocks every subsequent attempt.
 */
export async function generateRepoFromTemplate(
  input: GenerateRepoInput,
): Promise<{ repo: RepoSummary; created: boolean }> {
  const { installationId, templateOwner, templateRepo, owner, name } = input

  const existing = await getRepo(installationId, owner, name)
  if (existing) {
    // A repo left half-copied by an interrupted earlier attempt still needs the
    // wait before callers touch its contents.
    await waitForRepoContent(installationId, owner, name)
    return { repo: existing, created: false }
  }

  const data = await githubMutate(
    `generate repo ${owner}/${name} from template ${templateOwner}/${templateRepo}`,
    installationId,
    (octokit) =>
      octokit.rest.repos
        .createUsingTemplate({
          template_owner: templateOwner,
          template_repo: templateRepo,
          owner,
          name,
          private: input.private,
          description: input.description,
          // Students need the template's whole history for `git log` to be
          // meaningful, and instructors often ship starter commits.
          include_all_branches: false,
        })
        .then((r) => r.data),
  )

  // Generation is async — see waitForRepoContent. Callers write files and create
  // refs immediately after this returns, so the wait belongs here rather than in
  // each caller.
  const { ready, waitedMs } = await waitForRepoContent(installationId, owner, name)
  if (!ready) {
    throw new GitHubDomainError({
      kind: 'Unknown',
      message: `repo ${owner}/${name} was created but had no content after ${waitedMs}ms`,
      userMessage:
        'GitHub created the repository but had not finished copying the template. This is ' +
        'usually temporary — retry the provisioning job.',
      retryable: true,
      retryAfterMs: 30_000,
    })
  }

  // Re-read: the response from /generate reports the pre-copy state, so
  // defaultBranch and pushedAt are not yet trustworthy.
  const settled = await getRepo(installationId, owner, name)
  return { repo: settled ?? toSummary(data), created: true }
}

/**
 * Archive a repository — the reversible alternative to deletion when a student
 * is removed from an assignment. Archiving keeps the work recoverable, which
 * matters when the removal turns out to be a mistake or a grade is disputed.
 */
export async function archiveRepo(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<void> {
  await githubMutate(`archive repo ${owner}/${repo}`, installationId, (octokit) =>
    octokit.rest.repos.update({ owner, repo, archived: true }),
  )
}

/**
 * Permanently delete a repository. Irreversible on GitHub's side; callers must
 * have obtained explicit typed confirmation from the instructor.
 */
export async function deleteRepo(
  installationId: bigint,
  owner: string,
  repo: string,
): Promise<void> {
  try {
    await githubMutate(`delete repo ${owner}/${repo}`, installationId, (octokit) =>
      octokit.rest.repos.delete({ owner, repo }),
    )
  } catch (error) {
    // Already gone is success, not failure — a retried deletion must not error.
    if (error instanceof GitHubDomainError && error.status === 404) return
    throw error
  }
}

/** Last push time and head SHA of the default branch, for the overview table. */
export async function getRepoHead(
  installationId: bigint,
  owner: string,
  repo: string,
  branch?: string,
): Promise<{ sha: string; committedAt: string | null } | null> {
  try {
    const ref = branch ?? (await getRepo(installationId, owner, repo))?.defaultBranch ?? 'main'
    const data = await githubRead(
      `get branch ${ref} of repo ${owner}/${repo}`,
      installationId,
      (octokit) => octokit.rest.repos.getBranch({ owner, repo, branch: ref }).then((r) => r.data),
    )
    return {
      sha: data.commit.sha,
      committedAt: data.commit.commit.committer?.date ?? null,
    }
  } catch (error) {
    // An empty repository has no branch yet; that is a normal state, not an error.
    if (error instanceof GitHubDomainError && error.status === 404) return null
    throw toDomainError(error, `get head of repo ${owner}/${repo}`)
  }
}
