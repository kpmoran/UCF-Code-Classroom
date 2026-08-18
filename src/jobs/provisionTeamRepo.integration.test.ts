import { RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import { deleteRepo, getRepo } from '@/lib/github/operations/repos'
import { deleteTeam, getTeam, getTeamMembership } from '@/lib/github/operations/teams'
import { slugifyTeamName } from '@/lib/github/repoName'

import { provisionTeamRepo } from './provisionTeamRepo'

/**
 * Group-assignment provisioning against the real sandbox organization.
 *
 * This is the path the plan flagged as highest-risk, because it depends on the
 * App installation token being able to manage GitHub teams. Verified here end to
 * end: team creation, membership, repository generation, and the team's permission
 * on that repository — plus the late-joiner case, which re-runs the same job.
 *
 * `kpmoran` stands in for the student: a real account already in the org, so
 * memberships resolve without emailing anyone.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
const TEMPLATE = 'verify-template'
const PREFIX = 'teamtest'
const SLUG = 'teamtest-classroom'
const TEAM_NAME = 'Knights'

let installationId: bigint
let classroomId: string
let assignmentId: string
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
      name: 'Team Test Classroom',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      ownerTokenUserId: student.id,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      assignments: {
        create: {
          title: 'Team Test Assignment',
          slug: 'team-test-assignment',
          type: 'GROUP',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          maxTeamSize: 4,
          publishedAt: new Date(),
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id
}, 120_000)

/** Emails used by throwaway users in this spec. */
const THROWAWAY_EMAILS = ['late@integration.invalid', 'nogh-team@integration.invalid']

async function removeThrowawayUsers() {
  const users = await db.user.findMany({
    where: { email: { in: THROWAWAY_EMAILS } },
    select: { id: true },
  })
  if (users.length === 0) return
  const ids = users.map((u) => u.id)
  await db.teamMember.deleteMany({ where: { userId: { in: ids } } })
  await db.assignmentRepo.deleteMany({ where: { userId: { in: ids } } })
  await db.user.deleteMany({ where: { id: { in: ids } } })
}

beforeEach(removeThrowawayUsers)

afterEach(async () => {
  // Cleanup lives in hooks, not trailing statements: a failed assertion would
  // otherwise skip it and leave a unique email behind, breaking the next run.
  await removeThrowawayUsers()

  // Teams and repos are per-test; remove them so each test starts clean.
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

async function makeTeam(name: string, memberUserIds: string[]) {
  const team = await db.team.create({
    data: {
      assignmentId,
      name,
      members: { create: memberUserIds.map((userId) => ({ userId, role: 'MEMBER' as const })) },
    },
    select: { id: true },
  })

  const repo = await db.assignmentRepo.create({
    data: { assignmentId, teamId: team.id, status: RepoStatus.QUEUED },
    select: { id: true },
  })

  createdTeamSlugs.add(slugifyTeamName(`${PREFIX}-${name}`))
  createdRepos.add(slugifyTeamName(`${PREFIX}-${name}`))

  return { teamId: team.id, repoId: repo.id }
}

describe('provisionTeamRepo', () => {
  it('creates the GitHub team, the repository, and grants the team access', async () => {
    const { teamId, repoId } = await makeTeam(TEAM_NAME, [studentUserId])

    await provisionTeamRepo({ assignmentRepoId: repoId })

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const team = await db.team.findUniqueOrThrow({ where: { id: teamId } })

    console.log(
      `\n  status=${row.status} repo=${row.fullName} githubTeam=${team.githubTeamSlug}`,
    )

    expect(row.status).toBe(RepoStatus.READY)
    expect(row.fullName).toBe(`${ORG}/${PREFIX}-knights`)
    expect(team.githubTeamSlug).toBe(`${PREFIX}-knights`)
    expect(team.githubTeamId).not.toBeNull()

    // The GitHub team really exists.
    const githubTeam = await getTeam(installationId, ORG, team.githubTeamSlug!)
    expect(githubTeam).not.toBeNull()

    // The repository exists and is private.
    const remote = await getRepo(installationId, ORG, `${PREFIX}-knights`)
    expect(remote).not.toBeNull()
    expect(remote?.private).toBe(true)

    // The team has push access to it — the thing that actually lets students work.
    const octokit = getInstallationOctokit(installationId)
    const { data: permission } = await octokit.rest.teams.checkPermissionsForRepoInOrg({
      org: ORG,
      team_slug: team.githubTeamSlug!,
      owner: ORG,
      repo: `${PREFIX}-knights`,
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    })
    expect(permission.permissions?.push).toBe(true)

    // Membership state was recorded, so the UI can explain a pending invite.
    const member = await db.teamMember.findFirstOrThrow({ where: { teamId } })
    console.log(`  membership state recorded as: ${member.githubMembershipState}`)
    expect(['active', 'pending']).toContain(member.githubMembershipState)

    // And it agrees with GitHub.
    const state = await getTeamMembership(
      installationId,
      ORG,
      team.githubTeamSlug!,
      STUDENT_LOGIN,
    )
    expect(state).toBe(member.githubMembershipState)
  }, 240_000)

  it('names the GitHub team per assignment so teams do not collide across assignments', async () => {
    // Two assignments can both have a team called "Knights"; prefixing with the
    // assignment keeps them distinct in one organization.
    const { teamId, repoId } = await makeTeam(TEAM_NAME, [studentUserId])
    await provisionTeamRepo({ assignmentRepoId: repoId })

    const team = await db.team.findUniqueOrThrow({ where: { id: teamId } })
    expect(team.githubTeamSlug).toContain(PREFIX)
    expect(team.githubTeamSlug).not.toBe('knights')
  }, 240_000)

  it('is idempotent — a second run reuses the team and repository', async () => {
    const { teamId, repoId } = await makeTeam(TEAM_NAME, [studentUserId])

    await provisionTeamRepo({ assignmentRepoId: repoId })
    const first = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const firstTeam = await db.team.findUniqueOrThrow({ where: { id: teamId } })

    const reposBefore = await countOrgRepos()
    const teamsBefore = await countOrgTeams()

    await db.assignmentRepo.update({
      where: { id: repoId },
      data: { status: RepoStatus.QUEUED },
    })
    await provisionTeamRepo({ assignmentRepoId: repoId })

    const second = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const secondTeam = await db.team.findUniqueOrThrow({ where: { id: teamId } })

    expect(second.status).toBe(RepoStatus.READY)
    expect(second.fullName).toBe(first.fullName)
    expect(second.githubRepoId).toBe(first.githubRepoId)
    expect(secondTeam.githubTeamId).toBe(firstTeam.githubTeamId)
    expect(await countOrgRepos()).toBe(reposBefore)
    expect(await countOrgTeams()).toBe(teamsBefore)
  }, 300_000)

  it('adds a late joiner to the existing team rather than making a second repository', async () => {
    const { teamId, repoId } = await makeTeam(TEAM_NAME, [studentUserId])
    await provisionTeamRepo({ assignmentRepoId: repoId })

    const before = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    const reposBefore = await countOrgRepos()

    // A second student joins after the repository already exists. They have no
    // GitHub login, which is the common case for a student who has not linked yet.
    const latecomer = await db.user.create({
      data: { name: 'Late Joiner', email: 'late@integration.invalid' },
      select: { id: true },
    })
    await db.teamMember.create({
      data: { teamId, userId: latecomer.id, role: 'MEMBER' },
    })

    // Re-running the job is exactly how the app handles a membership change.
    await provisionTeamRepo({ assignmentRepoId: repoId })

    const after = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(after.fullName).toBe(before.fullName)
    expect(await countOrgRepos()).toBe(reposBefore)

    // The member without a GitHub account is reported as a warning, not a failure:
    // the rest of the team can still work.
    // The failure reason is included in the assertion message: without it, a
    // status mismatch here says nothing about the cause.
    expect(after.status, `failureReason was: ${after.failureReason}`).toBe(RepoStatus.READY)
    expect(after.failureReason).toMatch(/has not linked a GitHub account/)
    console.log(`\n  late joiner warning: ${after.failureReason}`)
  }, 300_000)

  it('fails clearly when no member has a linked GitHub account', async () => {
    const orphan = await db.user.create({
      data: { name: 'No GitHub', email: 'nogh-team@integration.invalid' },
      select: { id: true },
    })
    const { repoId } = await makeTeam('Ghosts', [orphan.id])

    await provisionTeamRepo({ assignmentRepoId: repoId })

    const row = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(row.status).toBe(RepoStatus.FAILED)
    expect(row.failureReason).toMatch(/No member of this team has a linked GitHub account/)
    // Nothing was created for a team that could not possibly work.
    expect(row.githubRepoId).toBeNull()
  }, 120_000)
})

async function countOrgRepos(): Promise<number> {
  const octokit = getInstallationOctokit(installationId)
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: ORG,
    per_page: 100,
  })
  return repos.length
}

async function countOrgTeams(): Promise<number> {
  const octokit = getInstallationOctokit(installationId)
  const teams = await octokit.paginate(octokit.rest.teams.list, { org: ORG, per_page: 100 })
  return teams.length
}
