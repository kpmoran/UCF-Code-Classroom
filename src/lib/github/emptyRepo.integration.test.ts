import { writeFileSync } from 'node:fs'

import { afterAll, describe, expect, it } from 'vitest'

import { injectAutogradingWorkflow } from '@/lib/autograding/inject'
import { ensureFeedbackPullRequest } from '@/lib/github/operations/pulls'
import { createEmptyRepo, getRepo } from '@/lib/github/operations/repos'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { githubMutate } from '@/lib/github/app'

/**
 * An assignment with no template produces an empty repository. This checks the
 * three things downstream that touch repository contents, because "empty" is a
 * genuinely different state on GitHub: no commit, no default branch.
 */

const NAME = 'verify-empty-repo-probe'
let installationId: bigint
let org: string
const log: string[] = []

afterAll(async () => {
  if (installationId) {
    await githubMutate(`delete ${org}/${NAME}`, installationId, (o) =>
      o.rest.repos.delete({ owner: org, repo: NAME }).catch(() => undefined),
    ).catch(() => undefined)
  }
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, log.join('\n'))
})

describe('empty repositories', () => {
  it('creates one, with no commits and no default branch', async () => {
    const [inst] = await listAppInstallations()
    installationId = inst.installationId
    org = inst.orgLogin

    // Clean slate if a previous run died before its teardown.
    await githubMutate(`pre-delete`, installationId, (o) =>
      o.rest.repos.delete({ owner: org, repo: NAME }).catch(() => undefined),
    ).catch(() => undefined)

    const first = await createEmptyRepo({
      installationId, owner: org, name: NAME, private: true,
      description: 'Probe for the no-template path',
    })
    expect(first.created).toBe(true)
    log.push(`  created: ${first.repo.fullName} private=${first.repo.private}`)

    // Truly empty: asking for the default branch's head must find nothing.
    const commits = await githubMutate(`list commits`, installationId, (o) =>
      o.rest.repos.listCommits({ owner: org, repo: NAME, per_page: 1 })
        .then((r) => r.data.length)
        .catch((e: { status?: number }) => (e.status === 409 ? 0 : -1)),
    )
    log.push(`  commits right after creation: ${commits} (409/0 = empty, as intended)`)
    expect(commits).toBe(0)
  }, 120_000)

  it('is idempotent, so a retried job does not trip over it', async () => {
    const again = await createEmptyRepo({
      installationId, owner: org, name: NAME, private: true,
    })
    expect(again.created).toBe(false)
    log.push(`  second call created=${again.created} (converged, no 422)`)
  }, 120_000)

  it('makes the feedback pull request skip instead of fail, while still empty', async () => {
    /*
     * A feedback PR needs a commit to pin its baseline at, and an empty repository
     * has none. The requirement is that this degrades rather than throws: the PR
     * opens by itself once the student pushes, so an assignment with no template
     * can still have feedback enabled.
     */
    const outcome = await ensureFeedbackPullRequest(installationId, org, NAME, 'main')
    log.push(`  feedback PR on an empty repo: state=${outcome.state} reason=${'reason' in outcome ? outcome.reason : '—'}`)
    expect(outcome.state).toBe('skipped')
  }, 120_000)

  it('accepts the autograding workflow, which becomes its first commit', async () => {
    const injected = await injectAutogradingWorkflow({
      installationId, owner: org, repo: NAME,
      tests: [
        { id: 't1', name: 'smoke', setupCommand: null, runCommand: 'true', timeoutMinutes: 1, points: 1 },
      ],
    })
    expect(injected.workflowChanged).toBe(true)

    const after = await githubMutate(`list commits after`, installationId, (o) =>
      o.rest.repos.listCommits({ owner: org, repo: NAME, per_page: 5 }).then((r) => r.data.length),
    )
    const repo = await getRepo(installationId, org, NAME)
    log.push(`  after writing the workflow: ${after} commit(s), default branch "${repo?.defaultBranch}"`)
    expect(after).toBeGreaterThan(0)
  }, 180_000)
})
