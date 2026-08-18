import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getInstallationOctokit } from './app'
import { GitHubDomainError } from './errors'
import { addCollaborator, isCollaborator, userExists } from './operations/collaborators'
import { getInitialCommitSha } from './operations/contents'
import { listAppInstallations } from './operations/orgs'
import { ensureFeedbackPullRequest } from './operations/pulls'
import {
  deleteRepo,
  generateRepoFromTemplate,
  getRepo,
  getRepoHead,
  listTemplateRepos,
  validateTemplate,
} from './operations/repos'
import { slugifyTeamName } from './repoName'

/**
 * End-to-end provisioning verification against a real organization.
 *
 * Creates and destroys real repositories, so it runs only against the sandbox
 * org. The template repo is created once and left in place for reuse; generated
 * repos are cleaned up.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const INSTRUCTOR = process.env.VERIFY_USER ?? 'kpmoran'

const TEMPLATE_REPO = 'verify-template'
const PLAIN_REPO = 'verify-not-a-template'
const GENERATED_REPO = 'verify-hw1-student1'
const TEAM_NAME = 'Verify Team Alpha'

let installationId: bigint

beforeAll(async () => {
  const installations = await listAppInstallations()
  const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
  if (!match) throw new Error(`App is not installed on ${ORG}`)
  installationId = match.installationId

  const octokit = getInstallationOctokit(installationId)

  // A template repository to generate from. Needs at least one commit,
  // otherwise there is nothing to template.
  if (!(await getRepo(installationId, ORG, TEMPLATE_REPO))) {
    await octokit.rest.repos.createInOrg({
      org: ORG,
      name: TEMPLATE_REPO,
      private: true,
      description: 'Template used by UCF-Code-Connect integration tests.',
      auto_init: true,
    })
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: TEMPLATE_REPO,
      path: 'src/solution.js',
      message: 'Add starter file',
      content: Buffer.from('// TODO: implement\nmodule.exports = () => 0\n').toString('base64'),
    })
    await octokit.rest.repos.update({ owner: ORG, repo: TEMPLATE_REPO, is_template: true })
  }

  // A plain repository, to prove validateTemplate rejects non-templates.
  if (!(await getRepo(installationId, ORG, PLAIN_REPO))) {
    await octokit.rest.repos.createInOrg({
      org: ORG,
      name: PLAIN_REPO,
      private: true,
      auto_init: true,
    })
  }

  // Start from a clean slate for the generated repo.
  await deleteRepo(installationId, ORG, GENERATED_REPO)
}, 180_000)

afterAll(async () => {
  if (!installationId) return
  await deleteRepo(installationId, ORG, GENERATED_REPO)

  // Remove the verification team if it was created.
  try {
    const octokit = getInstallationOctokit(installationId)
    await octokit.rest.teams.deleteInOrg({ org: ORG, team_slug: slugifyTeamName(TEAM_NAME) })
  } catch {
    // Never created, or already gone.
  }
}, 180_000)

describe('template validation', () => {
  it('accepts a real template repository', async () => {
    const result = await validateTemplate(installationId, ORG, TEMPLATE_REPO)
    expect(result.ok, 'ok' in result && !result.ok ? result.reason : '').toBe(true)
  })

  it('rejects a repository that is not marked as a template', async () => {
    const result = await validateTemplate(installationId, ORG, PLAIN_REPO)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not marked as a template/)
    console.log(`\n  Non-template rejection: ${result.reason}`)
  })

  it('rejects a repository that does not exist', async () => {
    const result = await validateTemplate(installationId, ORG, 'definitely-not-here-9z8y7x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Could not find/)
  })

  it('lists the template in the org template list', async () => {
    const templates = await listTemplateRepos(installationId, ORG)
    const names = templates.map((t) => t.name)
    console.log(`\n  Templates discovered in ${ORG}: ${names.join(', ') || '(none)'}`)
    expect(names).toContain(TEMPLATE_REPO)
    // The plain repo must not appear, or the assignment wizard offers repos
    // that cannot actually be generated from.
    expect(names).not.toContain(PLAIN_REPO)
  })
})

describe('repository generation', () => {
  it('creates a repository from the template and waits for the copy to finish', async () => {
    const started = Date.now()
    const result = await generateRepoFromTemplate({
      installationId,
      templateOwner: ORG,
      templateRepo: TEMPLATE_REPO,
      owner: ORG,
      name: GENERATED_REPO,
      private: true,
      description: 'Integration test generated repo',
    })

    console.log(
      `\n  Created ${result.repo.fullName} (created=${result.created}) in ${Date.now() - started}ms`,
    )
    expect(result.created).toBe(true)
    expect(result.repo.name).toBe(GENERATED_REPO)
    expect(result.repo.private).toBe(true)

    // The whole point of the fix: content must be readable the instant this
    // resolves, because provisioning writes files immediately afterwards.
    const head = await getRepoHead(installationId, ORG, GENERATED_REPO)
    expect(head, 'repo still empty after generate resolved').not.toBeNull()
  })

  it('is idempotent — a second run returns the same repo without creating another', async () => {
    // This is the retry path that matters most: a worker crash between repo
    // creation and the database write must not orphan a repo or fail forever.
    const result = await generateRepoFromTemplate({
      installationId,
      templateOwner: ORG,
      templateRepo: TEMPLATE_REPO,
      owner: ORG,
      name: GENERATED_REPO,
      private: true,
    })

    expect(result.created).toBe(false)
    expect(result.repo.name).toBe(GENERATED_REPO)
    console.log(`\n  Second run returned existing repo, created=${result.created}`)
  })

  it('carried the template contents across', async () => {
    const octokit = getInstallationOctokit(installationId)
    const { data } = await octokit.rest.repos.getContent({
      owner: ORG,
      repo: GENERATED_REPO,
      path: 'src/solution.js',
    })
    expect(Array.isArray(data)).toBe(false)
  })

  it('has a resolvable head and initial commit', async () => {
    const head = await getRepoHead(installationId, ORG, GENERATED_REPO)
    expect(head?.sha).toMatch(/^[0-9a-f]{40}$/)

    const repo = await getRepo(installationId, ORG, GENERATED_REPO)
    const initial = await getInitialCommitSha(
      installationId,
      ORG,
      GENERATED_REPO,
      repo!.defaultBranch,
    )
    expect(initial).toMatch(/^[0-9a-f]{40}$/)
    console.log(`\n  head=${head?.sha.slice(0, 8)} initial=${initial?.slice(0, 8)}`)
  })
})

describe('collaborator invitations', () => {
  it('maps a nonexistent user to a clear UserNotFound error', async () => {
    // GitHub answers this case with `403 Resource not accessible by integration`,
    // identical to a real permissions failure. The username pre-check turns it
    // into an accurate "no such account" so an instructor is not sent off to
    // audit their App installation over a typo.
    const attempt = addCollaborator(
      installationId,
      ORG,
      GENERATED_REPO,
      'this-user-does-not-exist-9z8y7x',
      'push',
    )

    await expect(attempt).rejects.toThrow(GitHubDomainError)
    await attempt.catch((error: GitHubDomainError) => {
      console.log(`\n  kind=${error.kind} status=${error.status}`)
      console.log(`  message shown to instructor: ${error.userMessage}`)
      expect(error.kind).toBe('UserNotFound')
      expect(error.retryable).toBe(false)
      expect(error.userMessage).toMatch(/no GitHub account named/)
    })
  })

  it('confirms a real non-member account resolves as existing', async () => {
    // Read-only existence check; sends no invitation. Proves the pre-check
    // distinguishes a real account from a typo rather than rejecting everything.
    expect(await userExists(installationId, 'octocat')).toBe(true)
    expect(await userExists(installationId, 'this-user-does-not-exist-9z8y7x')).toBe(false)
  })

  it('reports the instructor as already having access via org ownership', async () => {
    // An org owner already has admin on every repo, so this exercises the
    // "already a collaborator" branch rather than sending an invitation.
    const result = await addCollaborator(
      installationId,
      ORG,
      GENERATED_REPO,
      INSTRUCTOR,
      'push',
    )
    console.log(`\n  addCollaborator(${INSTRUCTOR}) => ${JSON.stringify(result)}`)
    expect(['invited', 'already-collaborator']).toContain(result.state)

    expect(await isCollaborator(installationId, ORG, GENERATED_REPO, INSTRUCTOR)).toBe(true)
  })
})

describe('feedback pull request', () => {
  it('pins a feedback branch at the initial commit', async () => {
    const repo = await getRepo(installationId, ORG, GENERATED_REPO)
    const result = await ensureFeedbackPullRequest(
      installationId,
      ORG,
      GENERATED_REPO,
      repo!.defaultBranch,
    )

    console.log(`\n  Feedback PR result: ${JSON.stringify(result)}`)

    // A freshly generated repo has a single squashed commit, so head === base
    // and GitHub refuses the PR. That is the expected state at accept time; the
    // PR opens once the student pushes. Verify we report it, not crash.
    if (result.state === 'skipped') {
      expect(result.reason).toMatch(/no commits|nothing to review/i)
    } else {
      expect(result.number).toBeGreaterThan(0)
    }

    // Either way the pinned branch must exist for the PR to be openable later.
    const octokit = getInstallationOctokit(installationId)
    const { data: ref } = await octokit.rest.git.getRef({
      owner: ORG,
      repo: GENERATED_REPO,
      ref: 'heads/feedback',
    })
    const initial = await getInitialCommitSha(
      installationId,
      ORG,
      GENERATED_REPO,
      repo!.defaultBranch,
    )
    expect(ref.object.sha).toBe(initial)
    console.log(`  feedback branch pinned at ${ref.object.sha.slice(0, 8)} (initial commit)`)
  })

  it('opens the PR once the student pushes a commit', async () => {
    // Simulate a student commit, then confirm the feedback PR becomes openable
    // and its diff is non-empty — the whole point of pinning the base.
    const octokit = getInstallationOctokit(installationId)
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: GENERATED_REPO,
      path: 'src/solution.js',
      message: 'Student attempt',
      content: Buffer.from('module.exports = () => 42\n').toString('base64'),
      sha: await currentFileSha(GENERATED_REPO, 'src/solution.js'),
    })

    const repo = await getRepo(installationId, ORG, GENERATED_REPO)
    const result = await ensureFeedbackPullRequest(
      installationId,
      ORG,
      GENERATED_REPO,
      repo!.defaultBranch,
    )

    console.log(`\n  After student commit: ${JSON.stringify(result)}`)
    expect(result.state === 'created' || result.state === 'existing').toBe(true)
    if (result.state === 'skipped') return

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: ORG,
      repo: GENERATED_REPO,
      pull_number: result.number,
    })
    console.log(`  PR #${result.number} diff contains ${files.length} file(s)`)
    expect(files.length).toBeGreaterThan(0)
  })
})

async function currentFileSha(repo: string, path: string): Promise<string | undefined> {
  const octokit = getInstallationOctokit(installationId)
  const { data } = await octokit.rest.repos.getContent({ owner: ORG, repo, path })
  return Array.isArray(data) ? undefined : (data as { sha: string }).sha
}
