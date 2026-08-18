import { RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { deleteRepo } from '@/lib/github/operations/repos'
import { deleteTeam } from '@/lib/github/operations/teams'
import { slugifyTeamName } from '@/lib/github/repoName'

import { enforceDeadlines } from './enforceDeadlines'
import { provisionIndividualRepo } from './provisionIndividualRepo'
import { provisionTeamRepo } from './provisionTeamRepo'

/**
 * Deadline enforcement against the real sandbox organization.
 *
 * Individual and team repositories grant access by different mechanisms —
 * per-repository collaborator versus team permission — so both paths are
 * exercised; confusing them would silently fail to lock group assignments.
 *
 * `kpmoran` stands in for the student and is an organization **owner**, which
 * bounds what can be proven here: GitHub reports `admin` for an owner on every
 * collaborator endpoint regardless of the grant, so the individual downgrade is
 * verified through bookkeeping plus a successful API call, while the **team**
 * downgrade is verified all the way to the effective permission. See
 * `isDirectCollaborator` for the measurements behind that.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'dltest'
const SLUG = 'dltest-classroom'

const PAST = new Date('2020-01-01T00:00:00.000Z')
const FUTURE = new Date('2099-01-01T00:00:00.000Z')

let installationId: bigint
let classroomId: string
let studentUserId: string

const createdRepos = new Set<string>()
const createdTeams = new Set<string>()

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
      name: 'Deadline Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      rosterEntries: {
        create: {
          displayName: 'Deadline, Test',
          sisUserId: '39600001',
          sisLoginId: 'dl600001',
          rawColumns: {},
          claimedByUserId: student.id,
          claimedAt: new Date(),
        },
      },
    },
    select: { id: true },
  })
  classroomId = classroom.id
}, 120_000)

afterEach(async () => {
  for (const slug of createdTeams) {
    await deleteTeam(classroomId, installationId, ORG, slug).catch(() => {})
  }
  createdTeams.clear()

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

/**
 * Whether the student is recorded as a **direct** collaborator on a repository.
 *
 * Deliberately not asserting the permission *level* for the individual path.
 * Verified empirically against this organization: GitHub reports `admin` for an
 * organization owner on every endpoint — `getCollaboratorPermissionLevel` and
 * `listCollaborators` alike — even immediately after granting them `pull`
 * directly. The owner role always wins, so with an owner as the test account the
 * downgrade is invisible on GitHub's side no matter which endpoint is read.
 *
 * The individual-repository lock is therefore verified here at two levels: the
 * bookkeeping (`lockedAt`, `deadlineSha`) and the fact that the GitHub call
 * succeeds without error. The **team** path below is verified all the way to the
 * effective permission, because a team's permission on a repository is
 * independent of any member's organization role.
 */
async function isDirectCollaborator(repoName: string): Promise<boolean> {
  const octokit = getInstallationOctokit(installationId)
  const { data } = await octokit.rest.repos.listCollaborators({
    owner: ORG,
    repo: repoName,
    affiliation: 'direct',
    per_page: 100,
  })
  return data.some((c) => c.login === STUDENT_LOGIN)
}

/** Read a team's permission on a repository. */
async function teamCanPush(teamSlug: string, repoName: string): Promise<boolean> {
  const octokit = getInstallationOctokit(installationId)
  try {
    const { data } = await octokit.rest.teams.checkPermissionsForRepoInOrg({
      org: ORG,
      team_slug: teamSlug,
      owner: ORG,
      repo: repoName,
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    })
    return data.permissions?.push === true
  } catch {
    return false
  }
}

async function makeIndividualAssignment(opts: {
  deadline: Date | null
  lockOnDeadline: boolean
}) {
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'Deadline Test Assignment',
      slug: `deadline-test-${Date.now()}`,
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      visibility: 'PRIVATE',
      studentPermission: 'PUSH',
      deadline: opts.deadline,
      lockOnDeadline: opts.lockOnDeadline,
      publishedAt: new Date(),
    },
    select: { id: true },
  })

  const row = await db.assignmentRepo.create({
    data: { assignmentId: assignment.id, userId: studentUserId, status: RepoStatus.QUEUED },
    select: { id: true },
  })
  await provisionIndividualRepo({ assignmentRepoId: row.id })

  const provisioned = await db.assignmentRepo.findUniqueOrThrow({ where: { id: row.id } })
  expect(provisioned.status).toBe(RepoStatus.READY)
  const name = provisioned.fullName!.split('/')[1]
  createdRepos.add(name)

  return { assignmentId: assignment.id, repoId: row.id, repoName: name }
}

describe('enforceDeadlines', () => {
  it('captures the submitted commit without locking when locking is off', async () => {
    const { repoId, repoName } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: false,
    })

    expect(await isDirectCollaborator(repoName)).toBe(true)

    const result = await enforceDeadlines()

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    // Recording the on-time state while letting students keep working is the
    // common arrangement, so capture must not imply locking.
    expect(row.deadlineSha).toMatch(/^[0-9a-f]{40}$/)
    expect(row.lockedAt).toBeNull()
    expect(result.captured).toBe(1)
    expect(result.locked).toBe(0)
    expect(result.failed).toBe(0)
    console.log(`\n  capture only: sha=${row.deadlineSha?.slice(0, 8)} locked=false`)
  }, 300_000)

  it('locks write access down to read when the deadline has passed', async () => {
    const { repoId, repoName } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: true,
    })

    const result = await enforceDeadlines()

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.lockedAt).not.toBeNull()
    expect(row.deadlineSha).toMatch(/^[0-9a-f]{40}$/)
    // The GitHub call went through without error, and the student remains a
    // direct collaborator (at read level, which an owner's role masks).
    expect(result.locked).toBe(1)
    expect(result.failed).toBe(0)
    expect(await isDirectCollaborator(repoName)).toBe(true)
    console.log(`\n  locked: lockedAt=${row.lockedAt?.toISOString()} failed=${result.failed}`)
  }, 300_000)

  it('does nothing before the deadline', async () => {
    const { repoId, repoName } = await makeIndividualAssignment({
      deadline: FUTURE,
      lockOnDeadline: true,
    })

    await enforceDeadlines()

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.lockedAt).toBeNull()
    expect(row.deadlineSha).toBeNull()
    expect(await isDirectCollaborator(repoName)).toBe(true)
  }, 300_000)

  it('restores write access when an extension is granted after locking', async () => {
    const { assignmentId, repoId, repoName } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: true,
    })

    const locking = await enforceDeadlines()
    expect(locking.locked).toBe(1)

    // The instructor grants an extension to the now-locked student.
    await db.extension.create({
      data: { assignmentId, userId: studentUserId, newDeadline: FUTURE, reason: 'Illness' },
    })

    const unlocking = await enforceDeadlines()

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.lockedAt).toBeNull()
    // Without this the extension would be meaningless — the student still could
    // not push.
    expect(unlocking.unlocked).toBe(1)
    expect(unlocking.failed).toBe(0)
    expect(await isDirectCollaborator(repoName)).toBe(true)
    console.log('\n  extension restored write access (unlocked=1)')
  }, 360_000)

  it('is idempotent — repeated sweeps do not churn permissions', async () => {
    const { repoId, repoName } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: true,
    })

    const first = await enforceDeadlines()
    expect(first.locked).toBe(1)

    const firstRow = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const lockedAt = firstRow.lockedAt

    // The sweep runs every few minutes, so a second pass must be a no-op rather
    // than re-locking and re-writing lockedAt.
    const second = await enforceDeadlines()
    expect(second.locked).toBe(0)
    expect(second.captured).toBe(0)
    expect(second.unlocked).toBe(0)

    const secondRow = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(secondRow.lockedAt?.toISOString()).toBe(lockedAt?.toISOString())
    expect(await isDirectCollaborator(repoName)).toBe(true)
  }, 360_000)

  it('releases a lock when the deadline is removed entirely', async () => {
    const { assignmentId, repoId, repoName } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: true,
    })

    expect((await enforceDeadlines()).locked).toBe(1)

    await db.assignment.update({ where: { id: assignmentId }, data: { deadline: null } })
    const result = await enforceDeadlines()

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.lockedAt).toBeNull()
    expect(result.unlocked).toBe(1)
    expect(await isDirectCollaborator(repoName)).toBe(true)
  }, 360_000)

  it('locks a team repository through the team permission, not a collaborator', async () => {
    // Group assignments grant access via the GitHub team, so locking has to change
    // the team's permission. Using the collaborator path here would appear to
    // succeed while leaving students able to push.
    const assignment = await db.assignment.create({
      data: {
        classroomId,
        title: 'Team Deadline Assignment',
        slug: `team-deadline-${Date.now()}`,
        type: 'GROUP',
        templateOwner: ORG,
        templateRepo: TEMPLATE,
        repoPrefix: PREFIX,
        visibility: 'PRIVATE',
        studentPermission: 'PUSH',
        deadline: PAST,
        lockOnDeadline: true,
        publishedAt: new Date(),
      },
      select: { id: true },
    })

    const team = await db.team.create({
      data: {
        assignmentId: assignment.id,
        name: 'Deadliners',
        members: { create: { userId: studentUserId, role: 'MEMBER' } },
      },
      select: { id: true },
    })
    const repoRow = await db.assignmentRepo.create({
      data: { assignmentId: assignment.id, teamId: team.id, status: RepoStatus.QUEUED },
      select: { id: true },
    })

    await provisionTeamRepo({ assignmentRepoId: repoRow.id })

    const provisioned = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoRow.id } })
    expect(provisioned.status).toBe(RepoStatus.READY)
    const repoName = provisioned.fullName!.split('/')[1]
    createdRepos.add(repoName)

    const teamSlug = slugifyTeamName(`${PREFIX}-Deadliners`)
    createdTeams.add(teamSlug)

    expect(await teamCanPush(teamSlug, repoName)).toBe(true)

    await enforceDeadlines()

    const locked = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoRow.id } })
    expect(locked.lockedAt).not.toBeNull()
    expect(await teamCanPush(teamSlug, repoName)).toBe(false)
    console.log('\n  team repo locked: team push access withdrawn')

    // And an extension for the team restores it.
    await db.extension.create({
      data: { assignmentId: assignment.id, teamId: team.id, newDeadline: FUTURE },
    })
    await enforceDeadlines()

    expect(await teamCanPush(teamSlug, repoName)).toBe(true)
    console.log('  team extension restored push access')
  }, 420_000)

  it('ignores archived classrooms', async () => {
    const { repoId } = await makeIndividualAssignment({
      deadline: PAST,
      lockOnDeadline: true,
    })
    await db.classroom.update({ where: { id: classroomId }, data: { archivedAt: new Date() } })

    const result = await enforceDeadlines()
    // Nothing from this classroom should have been examined.
    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.lockedAt).toBeNull()
    expect(result.locked).toBe(0)

    await db.classroom.update({ where: { id: classroomId }, data: { archivedAt: null } })
  }, 300_000)
})
