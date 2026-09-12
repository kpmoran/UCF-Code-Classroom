import { AutogradeStatus, RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import { isCollaborator } from '@/lib/github/operations/collaborators'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import {
  createEmptyRepo,
  deleteRepo,
  generateRepoFromTemplate,
  getRepo,
} from '@/lib/github/operations/repos'
import { deleteTeam } from '@/lib/github/operations/teams'
import { slugifyTeamName } from '@/lib/github/repoName'

import { ingestAutogradeRun } from './ingestAutogradeRun'
import { provisionIndividualRepo } from './provisionIndividualRepo'
import { provisionTeamRepo } from './provisionTeamRepo'

/**
 * Assignments that adopt repositories which already exist (`repoSource` EXISTING).
 *
 * The decisive assertion throughout is a **negative** one: that nothing was created.
 * Both creation helpers are idempotent by pre-check, so they return an existing
 * repository rather than failing — which means a bug in the adoption branch would not
 * throw, it would quietly create a repository beside the real one and look like a
 * success. Every test here therefore checks the name and id GitHub ended up with, not
 * just that the row says READY.
 *
 * Repositories to adopt are seeded here under names the naming scheme would never
 * produce, so a repository named `<prefix>-<login>` appearing anywhere is proof the
 * create path ran when it should not have.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'adopttest'
const SLUG = 'adopttest-classroom'
const TEAM_NAME = 'Adopters'

/** Seeded stand-ins for repositories that predate the assignment. */
const EXISTING_REPO = 'adopttest-legacy-project'
const EXISTING_PUBLIC_REPO = 'adopttest-legacy-public'
const EXISTING_TEAM_REPO = 'adopttest-legacy-team'
const SHARED_REPO = 'adopttest-legacy-shared'

let installationId: bigint
let classroomId: string
let individualAssignmentId: string
let groupAssignmentId: string
let studentUserId: string

const createdRepos = new Set<string>()
const createdTeamSlugs = new Set<string>()

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
      name: 'Adopt Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      assignments: {
        create: [
          {
            title: 'Adopt Test Individual',
            slug: 'adopt-test-individual',
            type: 'INDIVIDUAL',
            // Deliberately left set. A template is meaningless under EXISTING and the
            // job must ignore it; if the create branch ever runs, this is what it
            // would copy, making the mistake visible rather than silent.
            templateOwner: ORG,
            templateRepo: TEMPLATE,
            repoPrefix: PREFIX,
            repoSource: 'EXISTING',
            visibility: 'PRIVATE',
            studentPermission: 'PUSH',
            publishedAt: new Date(),
          },
          {
            title: 'Adopt Test Group',
            slug: 'adopt-test-group',
            type: 'GROUP',
            templateOwner: ORG,
            templateRepo: TEMPLATE,
            repoPrefix: PREFIX,
            repoSource: 'EXISTING',
            visibility: 'PRIVATE',
            studentPermission: 'PUSH',
            publishedAt: new Date(),
          },
        ],
      },
    },
    select: { id: true, assignments: { select: { id: true, type: true } } },
  })

  classroomId = classroom.id
  individualAssignmentId = classroom.assignments.find((a) => a.type === 'INDIVIDUAL')!.id
  groupAssignmentId = classroom.assignments.find((a) => a.type === 'GROUP')!.id
}, 120_000)

afterEach(async () => {
  for (const slug of createdTeamSlugs) {
    await deleteTeam(classroomId, installationId, ORG, slug).catch(() => {})
  }
  createdTeamSlugs.clear()

  for (const name of createdRepos) {
    await deleteRepo(installationId, ORG, name).catch(() => {})
  }
  createdRepos.clear()
}, 180_000)

afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
}, 120_000)

/** Seed a repository that stands in for one predating the assignment. */
async function seedExistingRepo(
  name: string,
  opts: { private?: boolean; fromTemplate?: boolean } = {},
): Promise<{ id: bigint; fullName: string }> {
  const seeded = opts.fromTemplate
    ? await generateRepoFromTemplate({
        installationId,
        templateOwner: ORG,
        templateRepo: TEMPLATE,
        owner: ORG,
        name,
        private: opts.private ?? true,
        description: 'Seeded by the adoption integration suite',
      })
    : await createEmptyRepo({
        installationId,
        owner: ORG,
        name,
        private: opts.private ?? true,
        description: 'Seeded by the adoption integration suite',
      })

  createdRepos.add(name)
  return { id: seeded.repo.id, fullName: seeded.repo.fullName }
}

/** Repository names currently in the org — used to prove nothing extra appeared. */
async function orgRepoNames(): Promise<Set<string>> {
  const octokit = getInstallationOctokit(installationId)
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: ORG,
    per_page: 100,
  })
  return new Set(repos.map((r) => r.name))
}

describe('adopting an existing repository — individual', () => {
  it('adopts the assigned repository instead of creating one, and grants access', async () => {
    const seeded = await seedExistingRepo(EXISTING_REPO, { fromTemplate: true })

    const row = await db.assignmentRepo.create({
      data: {
        assignmentId: individualAssignmentId,
        userId: studentUserId,
        status: RepoStatus.QUEUED,
        fullName: seeded.fullName,
      },
      select: { id: true },
    })

    const before = await orgRepoNames()
    await provisionIndividualRepo({ assignmentRepoId: row.id })
    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })

    console.log(`\n  adopted individual: status=${after.status} repo=${after.fullName}`)

    expect(after.status).toBe(RepoStatus.READY)
    expect(after.failureReason).toBeNull()

    // The repository it ended up with is the seeded one, by id — not merely by a
    // name that happens to match.
    expect(after.fullName).toBe(seeded.fullName)
    expect(after.githubRepoId).toBe(seeded.id)

    // And nothing was created beside it. A `<prefix>-<login>` repository here would
    // mean the create branch ran.
    const now = await orgRepoNames()
    const added = [...now].filter((n) => !before.has(n))
    expect(added).toEqual([])
    expect(now.has(`${PREFIX}-${STUDENT_LOGIN}`)).toBe(false)

    expect(await isCollaborator(installationId, ORG, EXISTING_REPO, STUDENT_LOGIN)).toBe(true)
  }, 240_000)

  it('leaves the repository’s visibility alone', async () => {
    /*
     * The assignment says PRIVATE; the repository is public and already has an
     * audience. Flipping it is not a side effect to bury in a provisioning job, so
     * the setting is ignored rather than applied — see the note in the job.
     */
    const seeded = await seedExistingRepo(EXISTING_PUBLIC_REPO, { private: false })

    const row = await db.assignmentRepo.create({
      data: {
        assignmentId: individualAssignmentId,
        userId: studentUserId,
        status: RepoStatus.QUEUED,
        fullName: seeded.fullName,
      },
      select: { id: true },
    })

    await provisionIndividualRepo({ assignmentRepoId: row.id })

    const remote = await getRepo(installationId, ORG, EXISTING_PUBLIC_REPO)
    expect(remote?.private).toBe(false)
  }, 240_000)

  it('fails, and creates nothing, when the assigned repository does not exist', async () => {
    /*
     * The failure this mode exists to prevent. Under CREATE this same input would
     * produce a brand new empty repository that looks provisioned, collects the
     * workflow, and is empty at the deadline.
     */
    const missing = `${ORG}/adopttest-does-not-exist-9z8y7x`
    const row = await db.assignmentRepo.create({
      data: {
        assignmentId: individualAssignmentId,
        userId: studentUserId,
        status: RepoStatus.QUEUED,
        fullName: missing,
      },
      select: { id: true },
    })

    const before = await orgRepoNames()
    await provisionIndividualRepo({ assignmentRepoId: row.id })
    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })

    console.log(`\n  missing repository: ${after.failureReason}`)

    expect(after.status).toBe(RepoStatus.FAILED)
    expect(after.failureReason).toMatch(/no longer exists|cannot see/i)
    expect(after.githubRepoId).toBeNull()

    const now = await orgRepoNames()
    expect([...now].filter((n) => !before.has(n))).toEqual([])
  }, 180_000)

  it('fails with an actionable message when no repository has been assigned', async () => {
    const row = await db.assignmentRepo.create({
      data: {
        assignmentId: individualAssignmentId,
        userId: studentUserId,
        status: RepoStatus.QUEUED,
      },
      select: { id: true },
    })

    const before = await orgRepoNames()
    await provisionIndividualRepo({ assignmentRepoId: row.id })
    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })

    expect(after.status).toBe(RepoStatus.FAILED)
    expect(after.failureReason).toMatch(/No repository has been assigned/i)
    expect(after.fullName).toBeNull()

    const now = await orgRepoNames()
    expect([...now].filter((n) => !before.has(n))).toEqual([])
  }, 180_000)
})

describe('adopting an existing repository — group', () => {
  it('adopts the linked repository and grants the team push access', async () => {
    const seeded = await seedExistingRepo(EXISTING_TEAM_REPO, { fromTemplate: true })

    const team = await db.team.create({
      data: {
        assignmentId: groupAssignmentId,
        name: TEAM_NAME,
        members: { create: { userId: studentUserId, role: 'LEADER' } },
      },
      select: { id: true },
    })
    createdTeamSlugs.add(slugifyTeamName(`${PREFIX}-${TEAM_NAME}`))

    const row = await db.assignmentRepo.create({
      data: {
        assignmentId: groupAssignmentId,
        teamId: team.id,
        status: RepoStatus.QUEUED,
        fullName: seeded.fullName,
      },
      select: { id: true },
    })

    const before = await orgRepoNames()
    await provisionTeamRepo({ assignmentRepoId: row.id })
    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })

    console.log(`\n  adopted team: status=${after.status} repo=${after.fullName}`)

    expect(after.status).toBe(RepoStatus.READY)
    expect(after.fullName).toBe(seeded.fullName)
    expect(after.githubRepoId).toBe(seeded.id)

    const now = await orgRepoNames()
    expect([...now].filter((n) => !before.has(n))).toEqual([])
    expect(now.has(`${PREFIX}-${slugifyTeamName(TEAM_NAME)}`)).toBe(false)

    // The GitHub team was still created and given access to the adopted repository —
    // the half of the job that does not change between the two modes.
    const stored = await db.team.findUniqueOrThrow({ where: { id: team.id } })
    expect(stored.githubTeamSlug).toBeTruthy()

    const octokit = getInstallationOctokit(installationId)
    const { data: permission } = await octokit.rest.teams.checkPermissionsForRepoInOrg({
      org: ORG,
      team_slug: stored.githubTeamSlug!,
      owner: ORG,
      repo: EXISTING_TEAM_REPO,
      // Without this GitHub answers 204 with no body, and `permissions` is absent —
      // which reads as "no push access" rather than "you did not ask for the detail".
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    })
    expect(permission.permissions?.push).toBe(true)
  }, 300_000)

  it('fails, and creates nothing, when no repository has been linked', async () => {
    const team = await db.team.create({
      data: {
        assignmentId: groupAssignmentId,
        name: TEAM_NAME,
        members: { create: { userId: studentUserId, role: 'LEADER' } },
      },
      select: { id: true },
    })
    createdTeamSlugs.add(slugifyTeamName(`${PREFIX}-${TEAM_NAME}`))

    const row = await db.assignmentRepo.create({
      data: { assignmentId: groupAssignmentId, teamId: team.id, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    const before = await orgRepoNames()
    await provisionTeamRepo({ assignmentRepoId: row.id })
    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })

    expect(after.status).toBe(RepoStatus.FAILED)
    expect(after.failureReason).toMatch(/No repository has been linked/i)

    const now = await orgRepoNames()
    expect([...now].filter((n) => !before.has(n))).toEqual([])
  }, 180_000)
})

describe('several students sharing one repository', () => {
  /*
   * The database half of sharing, which is where the schema change bites.
   *
   * The second student is a database-only user on purpose: ingestion fetches the
   * artifact once and writes a row per student, and touches no student's GitHub
   * identity at all. Using a fabricated login here would be misleading, not
   * convenient — so nothing in this test asks GitHub about them.
   *
   * A run id that exists nowhere stands in for a workflow that failed before its
   * upload step, which exercises the same fan-out as a successful ingest without
   * waiting on real Actions. The success path is covered in the autograding suite.
   */
  it('records the run against every student assigned the repository', async () => {
    const seeded = await seedExistingRepo(SHARED_REPO)

    await db.assignment.update({
      where: { id: individualAssignmentId },
      data: { autogradeEnabled: true },
    })

    const second = await db.user.create({
      data: { name: 'Second Student', email: 'shared-second@integration.invalid' },
      select: { id: true },
    })

    const rows = await Promise.all(
      [studentUserId, second.id].map((userId) =>
        db.assignmentRepo.create({
          data: {
            assignmentId: individualAssignmentId,
            userId,
            status: RepoStatus.READY,
            fullName: seeded.fullName,
            githubRepoId: seeded.id,
          },
          select: { id: true },
        }),
      ),
    )

    const workflowRunId = '999999999998'
    await ingestAutogradeRun({ githubRepoId: String(seeded.id), workflowRunId })

    const runs = await db.autogradeRun.findMany({
      where: { workflowRunId: BigInt(workflowRunId) },
      select: { assignmentRepoId: true, status: true },
    })

    console.log(`\n  shared repository produced ${runs.length} run row(s)`)

    // One per student. With the old global unique on workflowRunId this was 1, and
    // the second student had no record of the run at all.
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map((r) => r.assignmentRepoId))).toEqual(new Set(rows.map((r) => r.id)))
    expect(runs.every((r) => r.status === AutogradeStatus.FAILED)).toBe(true)

    // Re-ingesting is still idempotent per row rather than accumulating.
    await ingestAutogradeRun({ githubRepoId: String(seeded.id), workflowRunId })
    expect(
      await db.autogradeRun.count({ where: { workflowRunId: BigInt(workflowRunId) } }),
    ).toBe(2)

    await db.assignmentRepo.deleteMany({ where: { userId: second.id } })
    await db.user.delete({ where: { id: second.id } })
  }, 240_000)
})
