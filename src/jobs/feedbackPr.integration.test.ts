import { RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { MANIFEST_PATH, WORKFLOW_PATH } from '@/lib/autograding/renderWorkflow'
import { getInstallationOctokit } from '@/lib/github/app'
import { GitHubDomainError } from '@/lib/github/errors'
import { getRef } from '@/lib/github/operations/contents'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { FEEDBACK_BRANCH } from '@/lib/github/operations/pulls'
import { deleteRepo } from '@/lib/github/operations/repos'

import { ensureFeedbackPr } from './ensureFeedbackPr'
import { provisionIndividualRepo } from './provisionIndividualRepo'

/**
 * Feedback pull requests against the real sandbox organization.
 *
 * The assertion that matters most is what the diff *excludes*. Autograding injection
 * commits a workflow and a manifest, and an earlier version of this code pinned the
 * feedback baseline behind those commits — so every student's feedback PR would have
 * opened with our own files listed as their changes. Only a real diff from GitHub
 * can prove that is fixed.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'fbtest'
const SLUG = 'fbtest-classroom'

let installationId: bigint
let assignmentId: string
let studentUserId: string

const createdRepos = new Set<string>()

beforeAll(async () => {
  const installations = await listAppInstallations()
  const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
  if (!match) throw new Error(`App is not installed on ${ORG}`)
  installationId = match.installationId
}, 120_000)

beforeEach(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const student = await db.user.upsert({
    where: { githubLogin: STUDENT_LOGIN },
    update: {},
    create: {
      githubLogin: STUDENT_LOGIN,
      name: STUDENT_LOGIN,
      email: `${STUDENT_LOGIN}@integration.invalid`,
      githubId: '920000001',
    },
  })
  studentUserId = student.id

  const classroom = await db.classroom.create({
    data: {
      name: 'Feedback Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      rosterEntries: {
        create: {
          displayName: 'Feedback, Test',
          sisUserId: '40000001',
          sisLoginId: 'fb000001',
          rawColumns: {},
          claimedByUserId: student.id,
          claimedAt: new Date(),
        },
      },
      assignments: {
        create: {
          title: 'Feedback Test Assignment',
          slug: 'feedback-test-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          feedbackPrEnabled: true,
          // Enabled deliberately: its injected commits are exactly what must not
          // appear in the feedback diff.
          autogradeEnabled: true,
          publishedAt: new Date(),
          gradingTests: {
            create: [
              { name: 'Smoke', runCommand: 'echo ok', points: 10, timeoutMinutes: 5, order: 0 },
            ],
          },
        },
      },
    },
    select: { assignments: { select: { id: true } } },
  })

  assignmentId = classroom.assignments[0].id
}, 120_000)

afterEach(async () => {
  for (const name of createdRepos) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await deleteRepo(installationId, ORG, name)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
    }
  }
  createdRepos.clear()
}, 180_000)

afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
}, 120_000)

async function provision(): Promise<{ repoId: string; repoName: string }> {
  const row = await db.assignmentRepo.create({
    data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
    select: { id: true },
  })

  /**
   * Retry on retryable errors, mirroring what pg-boss does in production.
   *
   * The job signals a transient fault — a network timeout, a GitHub 5xx — by
   * throwing a retryable domain error, and the queue is what turns that into
   * another attempt. Calling the handler directly bypasses the queue, so without
   * this the suite fails on ordinary network weather rather than on a defect.
   * Assertion failures are unaffected and still fail immediately.
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await provisionIndividualRepo({ assignmentRepoId: row.id })
      break
    } catch (error) {
      const retryable = error instanceof GitHubDomainError && error.retryable
      if (!retryable || attempt === 2) throw error
      console.warn(`[test] provisioning attempt ${attempt + 1} failed transiently; retrying`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }

  const provisioned = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
  expect(provisioned.status).toBe(RepoStatus.READY)
  const name = provisioned.fullName!.split('/')[1]
  createdRepos.add(name)
  return { repoId: row.id, repoName: name }
}

/** Commit a file as the student would. */
async function studentPush(repoName: string, path: string, content: string): Promise<void> {
  const octokit = getInstallationOctokit(installationId)
  let sha: string | undefined
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: ORG, repo: repoName, path })
    if (!Array.isArray(data)) sha = (data as { sha: string }).sha
  } catch {
    // New file.
  }
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: ORG,
    repo: repoName,
    path,
    message: `Student work on ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
  })
}

describe('feedback pull requests', () => {
  it('pins the baseline after setup commits, not at the template commit', async () => {
    const { repoName } = await provision()

    const feedbackRef = await getRef(installationId, ORG, repoName, `heads/${FEEDBACK_BRANCH}`)
    expect(feedbackRef, 'feedback branch was not created').not.toBeNull()

    const octokit = getInstallationOctokit(installationId)
    const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
      owner: ORG,
      repo: repoName,
      per_page: 100,
    })

    const firstCommitSha = commits[commits.length - 1].sha
    const headSha = commits[0].sha

    console.log(
      `\n  commits=${commits.length} first=${firstCommitSha.slice(0, 8)} ` +
        `head=${headSha.slice(0, 8)} feedback=${feedbackRef!.sha.slice(0, 8)}`,
    )

    // Autograding injection made commits, so head has moved past the first commit.
    expect(commits.length).toBeGreaterThan(1)
    // The baseline must be at the head after setup — not the template commit.
    expect(feedbackRef!.sha).toBe(headSha)
    expect(feedbackRef!.sha).not.toBe(firstCommitSha)
  }, 300_000)

  it('is skipped until the student pushes, then opens', async () => {
    const { repoId, repoName } = await provision()

    // Nothing to review yet, so no PR — and no error.
    await ensureFeedbackPr({ assignmentRepoId: repoId })
    let row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.feedbackPrNumber).toBeNull()

    await studentPush(repoName, 'src/solution.js', 'module.exports = () => 42\n')

    await ensureFeedbackPr({ assignmentRepoId: repoId })
    row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.feedbackPrNumber, 'PR was not opened after the student pushed').not.toBeNull()
    console.log(`\n  feedback PR #${row.feedbackPrNumber} opened after first push`)
  }, 360_000)

  it('shows only the student’s files in the diff, not our injected ones', async () => {
    const { repoId, repoName } = await provision()

    await studentPush(repoName, 'src/solution.js', 'module.exports = () => 42\n')
    await studentPush(repoName, 'src/extra.js', '// more student work\n')

    await ensureFeedbackPr({ assignmentRepoId: repoId })
    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.feedbackPrNumber).not.toBeNull()

    const octokit = getInstallationOctokit(installationId)
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: ORG,
      repo: repoName,
      pull_number: row.feedbackPrNumber!,
      per_page: 100,
    })

    const paths = files.map((f) => f.filename).sort()
    console.log(`\n  feedback PR diff contains: ${paths.join(', ')}`)

    expect(paths).toEqual(['src/extra.js', 'src/solution.js'])
    // The regression this whole design exists to prevent.
    expect(paths).not.toContain(WORKFLOW_PATH)
    expect(paths).not.toContain(MANIFEST_PATH)
  }, 420_000)

  it('keeps growing as the student pushes more, without moving the base', async () => {
    const { repoId, repoName } = await provision()

    await studentPush(repoName, 'src/solution.js', 'module.exports = () => 1\n')
    await ensureFeedbackPr({ assignmentRepoId: repoId })

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const prNumber = row.feedbackPrNumber!
    const baseBefore = await getRef(installationId, ORG, repoName, `heads/${FEEDBACK_BRANCH}`)

    await studentPush(repoName, 'src/later.js', '// added later\n')

    /**
     * Polled, because GitHub recomputes a pull request's diff asynchronously after a
     * push — reading `listFiles` immediately returns the previous file list. The same
     * asynchrony shows up in template copying, workflow indexing and repository
     * deletion, so it is worth expecting rather than being surprised by.
     */
    const octokit = getInstallationOctokit(installationId)
    const started = Date.now()
    let paths: string[] = []

    while (Date.now() - started < 60_000) {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: ORG,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
      })
      paths = files.map((f) => f.filename).sort()
      if (paths.includes('src/later.js')) break
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // The later push appears in the same PR, and the base has not moved — which is
    // what makes the diff cumulative rather than only the newest commit.
    expect(paths, `diff after ${Date.now() - started}ms`).toEqual([
      'src/later.js',
      'src/solution.js',
    ])

    const baseAfter = await getRef(installationId, ORG, repoName, `heads/${FEEDBACK_BRANCH}`)
    expect(baseAfter!.sha).toBe(baseBefore!.sha)
    console.log(`\n  PR #${prNumber} now shows 2 files; base unchanged`)
  }, 420_000)

  it('is idempotent — a second call reuses the existing pull request', async () => {
    const { repoId, repoName } = await provision()
    await studentPush(repoName, 'src/solution.js', 'module.exports = () => 7\n')

    await ensureFeedbackPr({ assignmentRepoId: repoId })
    const first = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })

    // Clear our record and re-run: the job must find the existing PR rather than
    // opening a second one.
    await db.assignmentRepo.update({
      where: { id: repoId },
      data: { feedbackPrNumber: null },
    })
    await ensureFeedbackPr({ assignmentRepoId: repoId })

    const second = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(second.feedbackPrNumber).toBe(first.feedbackPrNumber)

    const octokit = getInstallationOctokit(installationId)
    const pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner: ORG,
      repo: repoName,
      state: 'all',
      base: FEEDBACK_BRANCH,
      per_page: 100,
    })
    expect(pulls).toHaveLength(1)
  }, 420_000)

  it('does nothing when feedback pull requests are disabled', async () => {
    const { repoId } = await provision()
    await db.assignment.update({
      where: { id: assignmentId },
      data: { feedbackPrEnabled: false },
    })

    await ensureFeedbackPr({ assignmentRepoId: repoId })
    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.feedbackPrNumber).toBeNull()
  }, 300_000)
})
