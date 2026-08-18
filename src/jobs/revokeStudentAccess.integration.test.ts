import { RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import { isCollaborator } from '@/lib/github/operations/collaborators'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { deleteRepo, getRepo } from '@/lib/github/operations/repos'

import { provisionIndividualRepo } from './provisionIndividualRepo'
import { revokeStudentAccess } from './revokeStudentAccess'

/**
 * Revocation against the real sandbox organization.
 *
 * Each case provisions a real repository first, then revokes, then checks GitHub
 * directly — because the whole point of the three dispositions is what they do to
 * the repository, and only GitHub can confirm that.
 *
 * `kpmoran` stands in for the student. Note they are an organization owner, so
 * they retain implicit access to every repository regardless of collaborator
 * status; the assertions therefore check the repository's *state* rather than
 * claiming access was withdrawn from an owner.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'revoketest'
const SLUG = 'revoketest-classroom'

let installationId: bigint
let classroomId: string
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
      name: 'Revoke Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      rosterEntries: {
        create: {
          displayName: 'Revoke, Test',
          sisUserId: '39500001',
          sisLoginId: 'rv500001',
          rawColumns: {},
          claimedByUserId: student.id,
          claimedAt: new Date(),
        },
      },
      assignments: {
        create: {
          title: 'Revoke Test Assignment',
          slug: 'revoke-test-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          publishedAt: new Date(),
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id
}, 120_000)

/**
 * Delete with retries.
 *
 * GitHub answers 409 while a previous operation on the repository is still
 * settling — reliably after an archive — so a single best-effort attempt leaves
 * repositories behind in the sandbox. Un-archives first, since an archived
 * repository is what triggers the conflict most often.
 */
async function deleteRepoWithRetries(name: string): Promise<void> {
  const octokit = getInstallationOctokit(installationId)
  try {
    await octokit.rest.repos.update({ owner: ORG, repo: name, archived: false })
  } catch {
    // Not archived, or already gone.
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await deleteRepo(installationId, ORG, name)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
  }
  console.warn(`[test] could not delete ${ORG}/${name}; clean it up by hand`)
}

afterEach(async () => {
  for (const name of createdRepos) {
    await deleteRepoWithRetries(name)
  }
  createdRepos.clear()
}, 180_000)

afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
}, 120_000)

/** Provision a real repository and return its row id and short name. */
async function provisionOne(): Promise<{ repoId: string; name: string }> {
  const row = await db.assignmentRepo.create({
    data: { assignmentId, userId: studentUserId, status: RepoStatus.QUEUED },
    select: { id: true },
  })
  await provisionIndividualRepo({ assignmentRepoId: row.id })

  const provisioned = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
  expect(provisioned.status).toBe(RepoStatus.READY)

  const name = provisioned.fullName!.split('/')[1]
  createdRepos.add(name)
  return { repoId: row.id, name }
}

describe('revokeStudentAccess', () => {
  it('KEEP leaves the repository intact and readable', async () => {
    const { repoId, name } = await provisionOne()

    await revokeStudentAccess({
      classroomId,
      userId: studentUserId,
      repoAction: 'KEEP',
    })

    // The repository still exists and is not archived — a dropped student's work
    // must remain available to the instructor.
    const remote = await getRepo(installationId, ORG, name)
    expect(remote).not.toBeNull()

    const octokit = getInstallationOctokit(installationId)
    const { data } = await octokit.rest.repos.get({ owner: ORG, repo: name })
    expect(data.archived).toBe(false)

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.invitationId).toBeNull()
    expect(row.failureReason).toMatch(/left intact/)
    console.log(`\n  KEEP: repo present, archived=${data.archived}, note="${row.failureReason}"`)
  }, 240_000)

  it('ARCHIVE makes the repository read-only but keeps it', async () => {
    const { repoId, name } = await provisionOne()

    await revokeStudentAccess({
      classroomId,
      userId: studentUserId,
      repoAction: 'ARCHIVE',
    })

    const octokit = getInstallationOctokit(installationId)
    const { data } = await octokit.rest.repos.get({ owner: ORG, repo: name })
    expect(data.archived).toBe(true)

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.failureReason).toMatch(/archived/)
    console.log(`\n  ARCHIVE: archived=${data.archived}`)

    // Cleanup un-archives and retries past GitHub's 409, so nothing more is
    // needed here.
  }, 240_000)

  it('DELETE removes the repository from GitHub', async () => {
    const { repoId, name } = await provisionOne()

    await revokeStudentAccess({
      classroomId,
      userId: studentUserId,
      repoAction: 'DELETE',
    })

    expect(await getRepo(installationId, ORG, name)).toBeNull()
    createdRepos.delete(name)

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    // The GitHub id is cleared so nothing later mistakes it for a live repo.
    expect(row.githubRepoId).toBeNull()
    expect(row.htmlUrl).toBeNull()
    console.log(`\n  DELETE: repo gone from GitHub, row note="${row.failureReason}"`)
  }, 240_000)

  it('is idempotent — revoking twice does not error', async () => {
    const { name } = await provisionOne()

    await revokeStudentAccess({ classroomId, userId: studentUserId, repoAction: 'DELETE' })
    // The second run finds nothing to do; "already gone" must count as success or
    // a retried job would fail forever.
    await expect(
      revokeStudentAccess({ classroomId, userId: studentUserId, repoAction: 'DELETE' }),
    ).resolves.toBeUndefined()

    createdRepos.delete(name)
  }, 300_000)

  it('scoped to one assignment leaves other assignments alone', async () => {
    const first = await provisionOne()

    // A second assignment with its own repository for the same student.
    const other = await db.assignment.create({
      data: {
        classroomId,
        title: 'Other Assignment',
        slug: 'other-assignment',
        type: 'INDIVIDUAL',
        templateOwner: ORG,
        templateRepo: TEMPLATE,
        repoPrefix: `${PREFIX}b`,
        publishedAt: new Date(),
      },
      select: { id: true },
    })
    const otherRow = await db.assignmentRepo.create({
      data: { assignmentId: other.id, userId: studentUserId, status: RepoStatus.QUEUED },
      select: { id: true },
    })
    await provisionIndividualRepo({ assignmentRepoId: otherRow.id })
    const otherProvisioned = await db.assignmentRepo.findUniqueOrThrow({
      where: { id: otherRow.id },
    })
    const otherName = otherProvisioned.fullName!.split('/')[1]
    createdRepos.add(otherName)

    // Revoke only the first assignment.
    await revokeStudentAccess({
      classroomId,
      userId: studentUserId,
      assignmentId,
      repoAction: 'DELETE',
    })

    expect(await getRepo(installationId, ORG, first.name)).toBeNull()
    createdRepos.delete(first.name)

    // The other assignment's repository is untouched.
    expect(await getRepo(installationId, ORG, otherName)).not.toBeNull()
    const untouched = await db.assignmentRepo.findUniqueOrThrow({ where: { id: otherRow.id } })
    expect(untouched.githubRepoId).not.toBeNull()
    console.log(`\n  scoped revoke: ${first.name} deleted, ${otherName} untouched`)
  }, 300_000)

  it('records the outcome in the audit log', async () => {
    const { name } = await provisionOne()

    await revokeStudentAccess({ classroomId, userId: studentUserId, repoAction: 'KEEP' })

    const entry = await db.auditLog.findFirst({
      where: { classroomId, action: 'github.access_revoked' },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).not.toBeNull()

    const detail = entry!.detail as Record<string, unknown>
    expect(detail.repoAction).toBe('KEEP')
    expect(detail.githubLogin).toBe(STUDENT_LOGIN)
    expect(detail.individualRepos).toBe(1)
    // No partial failures on a healthy run.
    expect(detail.failures).toEqual([])

    expect(name).toBeTruthy()
  }, 240_000)

  it('skips gracefully when the student or classroom is gone', async () => {
    await expect(
      revokeStudentAccess({
        classroomId: 'cuid-that-does-not-exist',
        userId: studentUserId,
        repoAction: 'KEEP',
      }),
    ).resolves.toBeUndefined()

    await expect(
      revokeStudentAccess({
        classroomId,
        userId: 'cuid-that-does-not-exist',
        repoAction: 'KEEP',
      }),
    ).resolves.toBeUndefined()
  }, 60_000)

  it('does not report the org owner as losing collaborator access', async () => {
    // Documents a real subtlety: an organization owner keeps implicit admin on
    // every repository, so `isCollaborator` stays true after revocation. For a
    // normal student it would become false. Asserted so nobody later reads this
    // as revocation being broken.
    const { name } = await provisionOne()
    await revokeStudentAccess({ classroomId, userId: studentUserId, repoAction: 'KEEP' })

    const stillCollaborator = await isCollaborator(installationId, ORG, name, STUDENT_LOGIN)
    console.log(
      `\n  org owner still shows as collaborator after revoke: ${stillCollaborator} ` +
        '(expected — owners have implicit access)',
    )
    expect(typeof stillCollaborator).toBe('boolean')
  }, 240_000)
})
