import { RepoStatus } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import { isCollaborator } from '@/lib/github/operations/collaborators'
import { deleteRepo, getRepo } from '@/lib/github/operations/repos'
import { listAppInstallations } from '@/lib/github/operations/orgs'

import { provisionIndividualRepo } from './provisionIndividualRepo'

/**
 * Provisioning against the real sandbox organization.
 *
 * The handler is invoked directly rather than through pg-boss so the assertions
 * are deterministic — the queue is verified separately. What matters here is that
 * the sequence of GitHub calls converges correctly, and that a retry after a
 * partial run does not create a second repository.
 *
 * `kpmoran` stands in for the student: a real account that already has org
 * access, so the collaborator step is exercised without emailing anyone.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'jobtest'
const SLUG = 'jobtest-classroom'

let installationId: bigint
let assignmentId: string
let studentUserId: string
const createdRepoNames = new Set<string>()

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
      name: 'Job Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      rosterEntries: {
        create: {
          displayName: 'Test, Student',
          sisUserId: '39000001',
          sisLoginId: 'jt900001',
          rawColumns: {},
          claimedByUserId: student.id,
          claimedAt: new Date(),
        },
      },
      assignments: {
        create: {
          title: 'Job Test Assignment',
          slug: 'job-test-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          feedbackPrEnabled: true,
          publishedAt: new Date(),
        },
      },
    },
    select: { assignments: { select: { id: true } } },
  })

  assignmentId = classroom.assignments[0].id
}, 120_000)

afterAll(async () => {
  for (const name of createdRepoNames) {
    await deleteRepo(installationId, ORG, name).catch(() => {})
  }
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
}, 180_000)

describe('provisionIndividualRepo', () => {
  it('creates the repository, grants access, and marks the row READY', async () => {
    const row = await db.assignmentRepo.create({
      data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    console.log(`\n  status=${after.status} repo=${after.fullName} feedbackPr=${after.feedbackPrNumber}`)

    expect(after.status).toBe(RepoStatus.READY)
    expect(after.failureReason).toBeNull()
    expect(after.fullName).toBe(`${ORG}/${PREFIX}-jt900001`)
    expect(after.githubRepoId).not.toBeNull()
    expect(after.htmlUrl).toContain(`${ORG}/${PREFIX}-jt900001`)

    createdRepoNames.add(`${PREFIX}-jt900001`)

    // The repository really exists, and the template content came across.
    const remote = await getRepo(installationId, ORG, `${PREFIX}-jt900001`)
    expect(remote).not.toBeNull()
    expect(remote?.private).toBe(true)

    const octokit = getInstallationOctokit(installationId)
    const { data: contents } = await octokit.rest.repos.getContent({
      owner: ORG,
      repo: `${PREFIX}-jt900001`,
      path: '',
    })
    const names = (contents as Array<{ name: string }>).map((c) => c.name)
    expect(names).toContain('src')

    // The student has access.
    expect(await isCollaborator(installationId, ORG, `${PREFIX}-jt900001`, STUDENT_LOGIN)).toBe(
      true,
    )
  }, 180_000)

  it('names the repository from the SIS login id, not the GitHub login', async () => {
    // The NID is stable across a GitHub rename and sorts with the Canvas roster.
    const row = await db.assignmentRepo.create({
      data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
      select: { id: true },
    })
    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.fullName).toContain('jt900001')
    expect(after.fullName).not.toContain(STUDENT_LOGIN)
    createdRepoNames.add(after.fullName!.split('/')[1])
  }, 180_000)

  it('is idempotent — a second run does not create a second repository', async () => {
    const row = await db.assignmentRepo.create({
      data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })
    const first = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    createdRepoNames.add(first.fullName!.split('/')[1])

    const before = await countOrgRepos()

    // Force it to run the whole sequence again, as a retry would.
    await db.assignmentRepo.update({
      where: { id: row.id },
      data: { status: RepoStatus.QUEUED },
    })
    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const second = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    expect(second.status).toBe(RepoStatus.READY)
    expect(second.fullName).toBe(first.fullName)
    expect(second.githubRepoId).toBe(first.githubRepoId)
    expect(await countOrgRepos()).toBe(before)
  }, 240_000)

  it('resumes rather than renaming when interrupted after the name was chosen', async () => {
    // Simulates a crash between persisting the name and creating the repo: the
    // stored name must be reused, or the first repository is orphaned.
    const row = await db.assignmentRepo.create({
      data: {
        assignmentId,
        userId: studentUserId,
        status: RepoStatus.QUEUED,
        fullName: `${ORG}/${PREFIX}-resumed`,
      },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe(RepoStatus.READY)
    expect(after.fullName).toBe(`${ORG}/${PREFIX}-resumed`)
    createdRepoNames.add(`${PREFIX}-resumed`)
  }, 180_000)

  it('fails with an actionable message when the student has no GitHub account', async () => {
    const orphan = await db.user.create({
      data: { name: 'No GitHub', email: 'nogh@integration.invalid' },
      select: { id: true },
    })
    const row = await db.assignmentRepo.create({
      data: { assignmentId, userId: orphan.id, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe(RepoStatus.FAILED)
    expect(after.failureReason).toMatch(/no linked GitHub account/)
    // Nothing was created on GitHub for a row that could never succeed.
    expect(after.githubRepoId).toBeNull()

    await db.user.delete({ where: { id: orphan.id } })
  }, 120_000)

  it('records a permanent failure instead of retrying forever', async () => {
    // A template that does not exist can never succeed, so the row must end up
    // FAILED with an explanation rather than cycling through retries.
    await db.assignment.update({
      where: { id: assignmentId },
      data: { templateRepo: 'definitely-not-a-real-template-9z8y7x' },
    })

    const row = await db.assignmentRepo.create({
      data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
    console.log(`\n  permanent failure: ${after.failureReason}`)
    expect(after.status).toBe(RepoStatus.FAILED)
    expect(after.failureReason).toBeTruthy()
  }, 120_000)

  it('skips a row that was deleted while the job waited', async () => {
    // A job can outlive its row when an instructor removes a student mid-queue.
    await expect(
      provisionIndividualRepo({ assignmentRepoId: 'cuid-that-does-not-exist' }),
    ).resolves.toBeUndefined()
  }, 60_000)
})

async function countOrgRepos(): Promise<number> {
  const octokit = getInstallationOctokit(installationId)
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: ORG,
    per_page: 100,
  })
  return repos.length
}
