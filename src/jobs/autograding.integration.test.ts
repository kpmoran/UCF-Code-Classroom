import { AutogradeStatus, RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import {
  MANIFEST_PATH,
  WORKFLOW_PATH,
} from '@/lib/autograding/renderWorkflow'
import { getInstallationOctokit } from '@/lib/github/app'
import { getFile } from '@/lib/github/operations/contents'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { deleteRepo } from '@/lib/github/operations/repos'

import { ingestAutogradeRun } from './ingestAutogradeRun'
import { provisionIndividualRepo } from './provisionIndividualRepo'

/**
 * Autograding end to end against real GitHub Actions.
 *
 * This is the only way to know the generated workflow is actually valid: a YAML
 * file that parses locally can still be rejected by Actions, and a collector
 * script that looks right can still fail in the runner. So this provisions a real
 * repository, waits for the workflow to run on GitHub's infrastructure, and
 * ingests the artifact it produces.
 *
 * Consequently it is slow — a runner takes a minute or two — and it consumes
 * Actions minutes. It is worth both.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'agtest'
const SLUG = 'agtest-classroom'

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
      name: 'Autograde Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      rosterEntries: {
        create: {
          displayName: 'Autograde, Test',
          sisUserId: '39800001',
          sisLoginId: 'ag800001',
          rawColumns: {},
          claimedByUserId: student.id,
          claimedAt: new Date(),
        },
      },
      assignments: {
        create: {
          title: 'Autograde Test Assignment',
          slug: 'autograde-test-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          autogradeEnabled: true,
          publishedAt: new Date(),
          gradingTests: {
            create: [
              {
                name: 'Always passes',
                runCommand: 'echo ok',
                points: 30,
                timeoutMinutes: 5,
                order: 0,
              },
              {
                name: 'Always fails',
                runCommand: 'exit 1',
                points: 70,
                timeoutMinutes: 5,
                order: 1,
              },
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
  await provisionIndividualRepo({ assignmentRepoId: row.id })

  const provisioned = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
  expect(provisioned.status).toBe(RepoStatus.READY)
  const name = provisioned.fullName!.split('/')[1]
  createdRepos.add(name)
  return { repoId: row.id, repoName: name }
}

/** Wait for a completed workflow run, polling GitHub. */
async function waitForCompletedRun(
  repoName: string,
  timeoutMs = 300_000,
): Promise<{ id: bigint; conclusion: string | null }> {
  const octokit = getInstallationOctokit(installationId)
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner: ORG,
      repo: repoName,
      per_page: 10,
    })
    const done = data.workflow_runs.find((run) => run.status === 'completed')
    if (done) return { id: BigInt(done.id), conclusion: done.conclusion }

    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  throw new Error(`No completed workflow run for ${repoName} within ${timeoutMs}ms`)
}

describe('autograding end to end', () => {
  it('injects a workflow and manifest that GitHub Actions accepts', async () => {
    const { repoName } = await provision()

    const workflow = await getFile(installationId, ORG, repoName, WORKFLOW_PATH)
    const manifest = await getFile(installationId, ORG, repoName, MANIFEST_PATH)

    expect(workflow, 'workflow was not written').not.toBeNull()
    expect(manifest, 'manifest was not written').not.toBeNull()

    // The manifest carries the names and points; the workflow must not.
    const parsedManifest = JSON.parse(manifest!.content)
    expect(parsedManifest.tests.map((t: { name: string }) => t.name)).toEqual([
      'Always passes',
      'Always fails',
    ])

    /**
     * GitHub registering the workflow is the real proof the YAML is valid: an
     * invalid file is rejected and never appears in this list.
     *
     * Polled, because indexing is **asynchronous** — measured against this org,
     * the workflow is absent from `listRepoWorkflows` for several seconds after
     * the commit lands, the same way a generated repository is briefly empty.
     */
    const octokit = getInstallationOctokit(installationId)
    const started = Date.now()
    let registered: { name?: string; state?: string } | undefined

    while (Date.now() - started < 60_000) {
      const { data } = await octokit.rest.actions.listRepoWorkflows({
        owner: ORG,
        repo: repoName,
      })
      registered = data.workflows.find((w) => w.path === WORKFLOW_PATH)
      if (registered) break
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    console.log(
      `\n  workflow registered by GitHub after ${Date.now() - started}ms: ` +
        `${registered?.name} (state=${registered?.state})`,
    )
    expect(registered, 'GitHub never indexed the workflow file').toBeDefined()
  }, 300_000)

  it('runs on GitHub and produces a score we can ingest', async () => {
    const { repoId, repoName } = await provision()

    // Provisioning committed the workflow, which itself triggers a run.
    const run = await waitForCompletedRun(repoName)
    console.log(`\n  workflow run ${run.id} completed with conclusion=${run.conclusion}`)

    await ingestAutogradeRun({
      githubRepoId: String(
        (await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })).githubRepoId,
      ),
      workflowRunId: String(run.id),
    })

    const stored = await db.autogradeRun.findUniqueOrThrow({
      where: { workflowRunId: run.id },
      include: { testResults: { orderBy: { name: 'asc' } } },
    })

    console.log(
      `  ingested: status=${stored.status} score=${stored.score}/${stored.maxScore}`,
    )
    for (const t of stored.testResults) {
      console.log(`    ${t.passed ? 'PASS' : 'FAIL'} ${t.name} ${t.points}/${t.maxPoints}`)
    }

    expect(stored.status).toBe(AutogradeStatus.COMPLETED)
    // One test echoes and passes (30), the other exits 1 and fails (0 of 70).
    expect(stored.maxScore).toBe(100)
    expect(stored.score).toBe(30)

    expect(stored.testResults).toHaveLength(2)
    const passes = stored.testResults.find((t) => t.name === 'Always passes')!
    const fails = stored.testResults.find((t) => t.name === 'Always fails')!

    expect(passes.passed).toBe(true)
    expect(passes.points).toBe(30)
    expect(fails.passed).toBe(false)
    expect(fails.points).toBe(0)
    // Partial credit only works because a failing step does not abort the job.
    expect(fails.maxPoints).toBe(70)

    // Each result is linked back to its configured test, which is what lets the
    // Canvas export name columns consistently.
    expect(passes.gradingTestId).not.toBeNull()

    // No discrepancies for an untampered run.
    const raw = stored.rawResults as { discrepancies?: unknown[]; warnings?: unknown[] }
    expect(raw.discrepancies).toEqual([])
    expect(raw.warnings).toEqual([])
  }, 600_000)

  it('is idempotent — re-ingesting the same run does not duplicate results', async () => {
    const { repoId, repoName } = await provision()
    const run = await waitForCompletedRun(repoName)

    const githubRepoId = String(
      (await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })).githubRepoId,
    )

    await ingestAutogradeRun({ githubRepoId, workflowRunId: String(run.id) })
    await ingestAutogradeRun({ githubRepoId, workflowRunId: String(run.id) })

    const runs = await db.autogradeRun.findMany({ where: { assignmentRepoId: repoId } })
    expect(runs).toHaveLength(1)

    const results = await db.autogradeTestResult.findMany({ where: { runId: runs[0].id } })
    expect(results).toHaveLength(2)
  }, 600_000)

  it('records a clear failure when a run produced no results artifact', async () => {
    const { repoId } = await provision()
    const githubRepoId = String(
      (await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })).githubRepoId,
    )

    // A run id that exists nowhere: stands in for a workflow that failed before
    // the upload step, which is the common real case.
    await ingestAutogradeRun({ githubRepoId, workflowRunId: '999999999999' })

    const stored = await db.autogradeRun.findUnique({
      where: { workflowRunId: BigInt('999999999999') },
    })
    expect(stored?.status).toBe(AutogradeStatus.FAILED)
    const raw = stored!.rawResults as { error?: string }
    expect(raw.error).toBeTruthy()
    console.log(`\n  no-artifact failure recorded: ${raw.error}`)
  }, 300_000)
})
