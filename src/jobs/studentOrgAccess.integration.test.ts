import { RepoStatus } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/lib/db'
import { getInstallationOctokit } from '@/lib/github/app'
import {
  cancelOrgInvitation,
  findPendingOrgInvitation,
  getOrgAccessSettings,
  getOrgMembership,
} from '@/lib/github/operations/orgMembers'
import { listAppInstallations } from '@/lib/github/operations/orgs'
import {
  createTeam,
  deleteTeam,
  getTeam,
  getTeamMembership,
} from '@/lib/github/operations/teams'
import { slugifyTeamName } from '@/lib/github/repoName'
import { reconcileOrgMemberships } from '@/lib/students/orgAccess'
import { studentTeamName } from '@/lib/students/orgRules'
import { enqueue, enqueueMany, QUEUES } from '@/jobs/queue'

import { inviteStudentToOrg } from './inviteStudentToOrg'
import { removeStudentFromOrg } from './removeStudentFromOrg'
import { resendTeamInvitation } from './resendTeamInvitation'

/**
 * Student organization membership against the real sandbox organization.
 *
 * These jobs rest on four things the App token was never asked to do before, and
 * the sandbox is the only place to find out whether it may:
 *
 *   1. Read the organization's base repository permission (`GET /orgs/{org}`
 *      returns `default_repository_permission` only to callers with organization
 *      administration read). The invite job refuses to proceed on anything above
 *      "No permission", so if this read came back empty the gate would wave
 *      everyone through.
 *   2. Read a user's organization membership, and get a clean 404 for a stranger.
 *   3. List and cancel the organization's pending invitations, which is how a
 *      resend works: GitHub returns no invitation id when a team add invites
 *      someone, so the job has to find it in the pending list by login.
 *   4. Create a membership-only team and put a member on it.
 *
 * What is deliberately *not* done here: inviting anyone who is not already in the
 * organization, and removing anyone who is. The stand-in student (`VERIFY_USER`) is
 * a member the other suites depend on, so the removal job is exercised only on its
 * refusal paths — every one of which must leave the stand-in exactly where they
 * were — and a real pending invitation is stood in for by one addressed to an
 * email with no account behind it, which GitHub accepts and which this file
 * cancels again.
 *
 * The sandbox's base permission is whatever its owner set, not something these
 * tests may change. So the invite job's happy path is reached by stubbing that one
 * read to "none", after a separate test has proved the real read works — and the
 * gate itself is tested with the real answer, whichever it is.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const STUDENT_LOGIN = process.env.VERIFY_USER ?? 'kpmoran'
/** A login GitHub has no account for. Membership reads must 404 cleanly, not throw. */
const GHOST_LOGIN = 'this-user-does-not-exist-9z8y7x'
/** An invitee with no GitHub account: the invitation exists, and nobody receives it. */
const INVITE_EMAIL = 'uccc-verify-invite@example.com'

const SLUG = 'jobtest-org-access'
const OTHER_SLUG = 'jobtest-org-access-other'
const COURSE_CODE = 'ORGTEST'
const TERM = 'Verify'
const ASSIGNMENT_TEAM = 'Org Test Knights'

/** Emails used by throwaway users in this spec; removed before and after each test. */
const THROWAWAY_EMAILS = ['ghost-org@integration.invalid', 'nologin-org@integration.invalid']

/*
 * The queue is stubbed so the jobs' follow-on work is observable without a running
 * pg-boss. Everything else about the module — queue names, payload types — is real.
 */
vi.mock('@/jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/queue')>()
  return {
    ...actual,
    enqueue: vi.fn(async () => 'stubbed-job'),
    enqueueMany: vi.fn(async (_name: string, jobs: unknown[]) => jobs.length),
  }
})

/*
 * The base-permission read is wrapped so one test at a time can stub it. By default
 * the real function runs, so the gate test and the "can it be read at all" test see
 * GitHub's actual answer.
 */
vi.mock('@/lib/github/operations/orgMembers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/operations/orgMembers')>()
  return { ...actual, getOrgAccessSettings: vi.fn(actual.getOrgAccessSettings) }
})

const NO_PERMISSION = { baseRepositoryPermission: 'none', membersCanCreateRepositories: false }

let installationId: bigint
let classroomId: string
let assignmentId: string
let studentUserId: string
let studentMemberId: string

const STUDENT_TEAM_SLUG = slugifyTeamName(
  studentTeamName({ name: 'Org Access Test Classroom', courseCode: COURSE_CODE, term: TERM }),
)
const ASSIGNMENT_TEAM_SLUG = slugifyTeamName(ASSIGNMENT_TEAM)

beforeAll(async () => {
  const installations = await listAppInstallations()
  const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
  if (!match) throw new Error(`App is not installed on ${ORG}`)
  installationId = match.installationId

  // A previous run that died mid-test may have left either team behind.
  await removeTeam(STUDENT_TEAM_SLUG)
  await removeTeam(ASSIGNMENT_TEAM_SLUG)
  await cancelInvitationsTo(INVITE_EMAIL)
}, 120_000)

beforeEach(async () => {
  vi.mocked(enqueue).mockClear()
  vi.mocked(enqueueMany).mockClear()
  vi.mocked(getOrgAccessSettings).mockReset()
  // Back to the real read after any test stubbed it.
  const actual = await vi.importActual<typeof import('@/lib/github/operations/orgMembers')>(
    '@/lib/github/operations/orgMembers',
  )
  vi.mocked(getOrgAccessSettings).mockImplementation(actual.getOrgAccessSettings)

  await db.classroom.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
  await removeThrowawayUsers()

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
      name: 'Org Access Test Classroom',
      slug: SLUG,
      courseCode: COURSE_CODE,
      term: TERM,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId,
      studentOrgAccess: true,
      members: { create: { userId: student.id, role: 'STUDENT' } },
      assignments: {
        create: {
          title: 'Org Test Assignment',
          slug: 'org-test-assignment',
          type: 'GROUP',
          templateOwner: ORG,
          templateRepo: 'verify-template',
          repoPrefix: 'orgtest',
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          publishedAt: new Date(),
        },
      },
    },
    select: {
      id: true,
      assignments: { select: { id: true } },
      members: { select: { id: true } },
    },
  })
  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id
  studentMemberId = classroom.members[0].id
}, 120_000)

afterEach(async () => {
  await removeThrowawayUsers()
  await removeTeam(STUDENT_TEAM_SLUG)
  await removeTeam(ASSIGNMENT_TEAM_SLUG)
  await cancelInvitationsTo(INVITE_EMAIL)
}, 180_000)

afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
  await db.$disconnect()
}, 120_000)

// ---------------------------------------------------------------------------

describe('what the App token may read about the organization', () => {
  it('reads the base repository permission, which the invitation gate depends on', async () => {
    const settings = await getOrgAccessSettings(installationId, ORG)

    console.log(
      `\n  ${ORG}: base permission=${settings.baseRepositoryPermission} ` +
        `membersCanCreateRepositories=${settings.membersCanCreateRepositories}`,
    )

    // Null would mean the App lacks organization administration read, and the gate
    // would then let students into an organization it cannot vouch for. The value
    // itself is the sandbox owner's choice; only its presence is asserted.
    expect(settings.baseRepositoryPermission).not.toBeNull()
    expect(['none', 'read', 'write', 'admin']).toContain(settings.baseRepositoryPermission)
  })

  it('reads a member’s organization membership and gets null for a stranger', async () => {
    const member = await getOrgMembership(installationId, ORG, STUDENT_LOGIN)
    console.log(`\n  ${STUDENT_LOGIN}: ${JSON.stringify(member)}`)
    expect(member?.state).toBe('active')
    expect(['member', 'admin']).toContain(member?.role)

    // A 404 is the normal answer for someone who has never been invited; it must
    // read as "no membership", not as an error that fails a whole class's check.
    expect(await getOrgMembership(installationId, ORG, GHOST_LOGIN)).toBeNull()
  })

  it('lists pending invitations and cancels one, which is how a resend starts', async () => {
    const octokit = getInstallationOctokit(installationId)
    const { data: created } = await octokit.rest.orgs.createInvitation({
      org: ORG,
      email: INVITE_EMAIL,
      role: 'direct_member',
    })
    console.log(`\n  created invitation ${created.id} to ${INVITE_EMAIL}`)

    // Listing works, and the lookup is by login: an invitation addressed to an
    // email has no login, so it must not be mistaken for the student's.
    expect(await findPendingOrgInvitation(installationId, ORG, STUDENT_LOGIN)).toBeNull()
    expect(await pendingInvitationIdsTo(INVITE_EMAIL)).toContain(BigInt(created.id))

    await cancelOrgInvitation(classroomId, installationId, ORG, BigInt(created.id))
    expect(await pendingInvitationIdsTo(INVITE_EMAIL)).not.toContain(BigInt(created.id))

    // Cancelling again is a no-op, not an error: a job retried after a rate-limit
    // refusal between its two writes must converge, not fail.
    await expect(
      cancelOrgInvitation(classroomId, installationId, ORG, BigInt(created.id)),
    ).resolves.toBeUndefined()
  }, 120_000)
})

// ---------------------------------------------------------------------------

describe('inviteStudentToOrg', () => {
  it('refuses while the base permission is above "No permission", creating nothing', async () => {
    const real = await getOrgAccessSettings(installationId, ORG)
    if (real.baseRepositoryPermission === 'none' || real.baseRepositoryPermission === null) {
      // The gate is open for real here; the stub below closes it so the refusal
      // path is still exercised against this organization.
      vi.mocked(getOrgAccessSettings).mockResolvedValueOnce({
        ...real,
        baseRepositoryPermission: 'read',
      })
    }

    await inviteStudentToOrg({ classroomMemberId: studentMemberId })

    const member = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    console.log(`\n  gate: orgState=${member.orgState} reason=${member.orgFailure}`)

    expect(member.orgState).toBe('failed')
    expect(member.orgFailure).toMatch(/base repository permission/)
    expect(member.orgFailure).toMatch(/No permission/)
    expect(member.orgJoinedViaClassroom).toBe(false)

    // Refused before anything was created: no student team, no follow-on jobs.
    expect(await getTeam(installationId, ORG, STUDENT_TEAM_SLUG)).toBeNull()
    expect(enqueueMany).not.toHaveBeenCalled()
  }, 120_000)

  it('makes a member active through the student team, and never claims a member it did not add', async () => {
    vi.mocked(getOrgAccessSettings).mockResolvedValueOnce(NO_PERMISSION)

    // A repository invitation issued before they joined; membership should
    // replace it with direct access, via the resend queue.
    const repo = await db.assignmentRepo.create({
      data: {
        assignmentId,
        userId: studentUserId,
        status: RepoStatus.READY,
        fullName: `${ORG}/orgtest-pending`,
        invitationId: BigInt(1),
      },
      select: { id: true },
    })

    await inviteStudentToOrg({ classroomMemberId: studentMemberId })

    const member = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    const classroom = await db.classroom.findUniqueOrThrow({ where: { id: classroomId } })
    console.log(
      `\n  invite: orgState=${member.orgState} joinedViaClassroom=${member.orgJoinedViaClassroom} ` +
        `team=${classroom.studentTeamSlug}`,
    )

    expect(member.orgState, `orgFailure was: ${member.orgFailure}`).toBe('active')
    expect(member.orgFailure).toBeNull()
    expect(member.orgInvitedAt).toBeNull()
    // Already a member before this classroom: not ours to remove at the end of term.
    expect(member.orgJoinedViaClassroom).toBe(false)

    // The team exists, is remembered, holds the student, and grants no repository.
    expect(classroom.studentTeamSlug).toBe(STUDENT_TEAM_SLUG)
    const team = await getTeam(installationId, ORG, STUDENT_TEAM_SLUG)
    expect(team).not.toBeNull()
    expect(await getTeamMembership(installationId, ORG, STUDENT_TEAM_SLUG, STUDENT_LOGIN)).toBe(
      'active',
    )
    const octokit = getInstallationOctokit(installationId)
    const { data: teamRepos } = await octokit.rest.teams.listReposInOrg({
      org: ORG,
      team_slug: STUDENT_TEAM_SLUG,
    })
    expect(teamRepos).toHaveLength(0)

    // The outstanding repository invitation is queued to become direct access.
    expect(enqueueMany).toHaveBeenCalledTimes(1)
    const [queue, jobs] = vi.mocked(enqueueMany).mock.calls[0]
    expect(queue).toBe(QUEUES.resendInvitation)
    expect(jobs).toEqual([{ data: { assignmentRepoId: repo.id }, singletonKey: `resend:${repo.id}` }])
  }, 180_000)

  it('is idempotent, and a resend for an active member cancels nothing', async () => {
    vi.mocked(getOrgAccessSettings).mockResolvedValue(NO_PERMISSION)

    await inviteStudentToOrg({ classroomMemberId: studentMemberId })
    const teamsAfterFirst = await countOrgTeams()

    // A second plain run is a no-op for an active member.
    await inviteStudentToOrg({ classroomMemberId: studentMemberId })
    // A resend re-adds them; they are active, so there is no invitation to cancel
    // and the membership simply stays active.
    await inviteStudentToOrg({ classroomMemberId: studentMemberId, resend: true })

    const member = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    expect(member.orgState, `orgFailure was: ${member.orgFailure}`).toBe('active')
    expect(member.orgJoinedViaClassroom).toBe(false)
    expect(await countOrgTeams()).toBe(teamsAfterFirst)
    expect(await getTeamMembership(installationId, ORG, STUDENT_TEAM_SLUG, STUDENT_LOGIN)).toBe(
      'active',
    )
  }, 240_000)

  it('fails clearly for a student with no linked GitHub account, without touching GitHub', async () => {
    const orphan = await db.user.create({
      data: { name: 'No Login', email: 'nologin-org@integration.invalid' },
      select: { id: true },
    })
    const member = await db.classroomMember.create({
      data: { classroomId, userId: orphan.id, role: 'STUDENT' },
      select: { id: true },
    })

    await inviteStudentToOrg({ classroomMemberId: member.id })

    const row = await db.classroomMember.findUniqueOrThrow({ where: { id: member.id } })
    expect(row.orgState).toBe('failed')
    expect(row.orgFailure).toMatch(/no linked GitHub account/)
    expect(getOrgAccessSettings).not.toHaveBeenCalled()
    expect(await getTeam(installationId, ORG, STUDENT_TEAM_SLUG)).toBeNull()
  }, 60_000)
})

// ---------------------------------------------------------------------------

describe('reconcileOrgMemberships', () => {
  it('marks a pending row active once GitHub says so, and expired for someone it has never heard of', async () => {
    // The stand-in is a member; the row says pending, as it would after an
    // invitation this app sent and never heard back about.
    await db.classroomMember.update({
      where: { id: studentMemberId },
      data: { orgState: 'pending', orgInvitedAt: new Date(), orgFailure: 'stale' },
    })
    const repo = await db.assignmentRepo.create({
      data: {
        assignmentId,
        userId: studentUserId,
        status: RepoStatus.READY,
        fullName: `${ORG}/orgtest-pending`,
        invitationId: BigInt(1),
      },
      select: { id: true },
    })

    // Someone GitHub has no record of: invited once, now gone from the pending list.
    const ghost = await db.user.create({
      data: {
        name: 'Ghost',
        email: 'ghost-org@integration.invalid',
        githubLogin: GHOST_LOGIN,
        githubId: '920000002',
      },
      select: { id: true },
    })
    const ghostMember = await db.classroomMember.create({
      data: { classroomId, userId: ghost.id, role: 'STUDENT', orgState: 'pending' },
      select: { id: true },
    })

    const result = await reconcileOrgMemberships(classroomId)
    console.log(`\n  reconcile: checked=${result.checked} activated=${result.activated}`)

    expect(result).toEqual({ checked: 2, activated: 1 })

    const student = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    expect(student.orgState).toBe('active')
    expect(student.orgFailure).toBeNull()

    const stranger = await db.classroomMember.findUniqueOrThrow({ where: { id: ghostMember.id } })
    expect(stranger.orgState).toBe('expired')

    // Becoming active converts their outstanding repository invitation.
    expect(enqueueMany).toHaveBeenCalledWith(QUEUES.resendInvitation, [
      { data: { assignmentRepoId: repo.id }, singletonKey: `resend:${repo.id}` },
    ])
  }, 120_000)
})

// ---------------------------------------------------------------------------

describe('removeStudentFromOrg', () => {
  /*
   * Only refusals here, on purpose. Every case below must end with the stand-in
   * still an active member — it is the account every other suite relies on — so
   * none of them may reach the GitHub write. The decision itself is unit tested
   * in orgRules.test.ts; what this proves is that the real membership read feeds
   * it correctly and that a refusal is recorded where the instructor will see it.
   */

  it('leaves someone who was already a member before the classroom invited them', async () => {
    await db.classroomMember.update({
      where: { id: studentMemberId },
      data: { orgState: 'active', orgJoinedViaClassroom: false },
    })

    await removeStudentFromOrg({ classroomId, userId: studentUserId, mode: 'REMOVE' })

    const member = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    console.log(`\n  removal refused: ${member.orgFailure}`)
    expect(member.orgState).toBe('active')
    expect(member.orgFailure).toMatch(/already a member before this classroom invited them/)

    const membership = await getOrgMembership(installationId, ORG, STUDENT_LOGIN)
    expect(membership?.state).toBe('active')
  }, 60_000)

  it('leaves someone another active classroom in the organization still needs', async () => {
    await db.classroomMember.update({
      where: { id: studentMemberId },
      data: { orgState: 'active', orgJoinedViaClassroom: true },
    })
    // The same student, in another classroom here that also grants membership.
    await db.classroom.create({
      data: {
        name: 'Other Org Access Classroom',
        slug: OTHER_SLUG,
        githubOrgLogin: ORG,
        githubOrgId: BigInt(317991529),
        installationId,
        studentOrgAccess: true,
        members: { create: { userId: studentUserId, role: 'STUDENT' } },
      },
    })

    await removeStudentFromOrg({ classroomId, userId: studentUserId, mode: 'CONVERT' })

    const member = await db.classroomMember.findUniqueOrThrow({ where: { id: studentMemberId } })
    console.log(`\n  removal refused: ${member.orgFailure}`)
    expect(member.orgState).toBe('active')
    expect(member.orgFailure).toMatch(/still a student in another active classroom/)

    const membership = await getOrgMembership(installationId, ORG, STUDENT_LOGIN)
    expect(membership?.state).toBe('active')
  }, 60_000)

  it('records someone GitHub no longer has as removed, with nothing to do', async () => {
    const ghost = await db.user.create({
      data: {
        name: 'Ghost',
        email: 'ghost-org@integration.invalid',
        githubLogin: GHOST_LOGIN,
        githubId: '920000002',
      },
      select: { id: true },
    })
    const ghostMember = await db.classroomMember.create({
      data: {
        classroomId,
        userId: ghost.id,
        role: 'STUDENT',
        orgState: 'expired',
        orgJoinedViaClassroom: true,
      },
      select: { id: true },
    })

    await removeStudentFromOrg({ classroomId, userId: ghost.id, mode: 'REMOVE' })

    const row = await db.classroomMember.findUniqueOrThrow({ where: { id: ghostMember.id } })
    expect(row.orgState).toBe('removed')
    expect(row.orgFailure).toBeNull()
  }, 60_000)
})

// ---------------------------------------------------------------------------

describe('resendTeamInvitation', () => {
  /**
   * A group-assignment team on GitHub with its rows in the database, as
   * provisioning would have left them — except that the membership is recorded
   * as pending, which is the state a resend is for.
   */
  async function makeProvisionedTeam(memberUserId: string) {
    const { team: githubTeam } = await createTeam(
      classroomId,
      installationId,
      ORG,
      ASSIGNMENT_TEAM,
      'UCF Code Classroom verification team',
    )
    const team = await db.team.create({
      data: {
        assignmentId,
        name: ASSIGNMENT_TEAM,
        githubTeamId: githubTeam.id,
        githubTeamSlug: githubTeam.slug,
        members: { create: { userId: memberUserId, role: 'MEMBER', githubMembershipState: 'pending' } },
      },
      select: { id: true, members: { select: { id: true } } },
    })
    const repo = await db.assignmentRepo.create({
      data: {
        assignmentId,
        teamId: team.id,
        status: RepoStatus.READY,
        fullName: `${ORG}/orgtest-knights`,
        failureReason: 'An earlier warning.',
      },
      select: { id: true },
    })
    return { teamMemberId: team.members[0].id, repoId: repo.id }
  }

  it('re-adds a member who has since joined the organization and records them active', async () => {
    const { teamMemberId, repoId } = await makeProvisionedTeam(studentUserId)

    await resendTeamInvitation({ teamMemberId })

    const member = await db.teamMember.findUniqueOrThrow({ where: { id: teamMemberId } })
    console.log(`\n  team resend: membershipState=${member.githubMembershipState}`)
    expect(member.githubMembershipState).toBe('active')

    // GitHub agrees, and the existing warning on the repository was kept.
    expect(
      await getTeamMembership(installationId, ORG, ASSIGNMENT_TEAM_SLUG, STUDENT_LOGIN),
    ).toBe('active')
    const repo = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    expect(repo.failureReason).toBe('An earlier warning.')

    // Active means no organization invitation to carry the student team, so the
    // classroom's own invite job is not queued.
    expect(enqueue).not.toHaveBeenCalled()
  }, 120_000)

  it('does nothing for a membership that is not pending', async () => {
    const { teamMemberId } = await makeProvisionedTeam(studentUserId)
    await db.teamMember.update({
      where: { id: teamMemberId },
      data: { githubMembershipState: 'active' },
    })
    const callsBefore = vi.mocked(getOrgAccessSettings).mock.calls.length

    await resendTeamInvitation({ teamMemberId })

    const member = await db.teamMember.findUniqueOrThrow({ where: { id: teamMemberId } })
    expect(member.githubMembershipState).toBe('active')
    expect(vi.mocked(getOrgAccessSettings).mock.calls.length).toBe(callsBefore)
  }, 60_000)

  it('puts a failure on the team’s repository, per student, when GitHub refuses', async () => {
    const ghost = await db.user.create({
      data: {
        name: 'Ghost',
        email: 'ghost-org@integration.invalid',
        githubLogin: GHOST_LOGIN,
        githubId: '920000002',
      },
      select: { id: true },
    })
    const { teamMemberId, repoId } = await makeProvisionedTeam(ghost.id)

    await resendTeamInvitation({ teamMemberId })

    const member = await db.teamMember.findUniqueOrThrow({ where: { id: teamMemberId } })
    const repo = await db.assignmentRepo.findUniqueOrThrow({ where: { id: repoId } })
    console.log(`\n  team resend for a stranger: ${repo.failureReason}`)

    // Still pending: nothing was accepted, and the row must not pretend otherwise.
    expect(member.githubMembershipState).toBe('pending')
    // The earlier warning is kept; this student's failure is appended and names them.
    expect(repo.failureReason).toMatch(/^An earlier warning\./)
    expect(repo.failureReason).toContain(
      `Could not resend the GitHub team invitation for @${GHOST_LOGIN}:`,
    )
  }, 120_000)
})

// ---------------------------------------------------------------------------

async function removeThrowawayUsers() {
  const users = await db.user.findMany({
    where: { OR: [{ email: { in: THROWAWAY_EMAILS } }, { githubLogin: GHOST_LOGIN }] },
    select: { id: true },
  })
  if (users.length === 0) return
  const ids = users.map((u) => u.id)
  await db.teamMember.deleteMany({ where: { userId: { in: ids } } })
  await db.assignmentRepo.deleteMany({ where: { userId: { in: ids } } })
  await db.user.deleteMany({ where: { id: { in: ids } } })
}

/**
 * Delete a team and wait for GitHub to stop reporting it.
 *
 * Team deletion is eventually consistent, and every test here reuses the same
 * two team names: without the wait, the next test's get-or-create adopts the team
 * this one just deleted and its membership calls 404. See provisionTeamRepo's
 * integration test for the longer version of this story.
 */
async function removeTeam(slug: string, timeoutMs = 15_000): Promise<void> {
  if (!(await getTeam(installationId, ORG, slug))) return
  await deleteTeam('', installationId, ORG, slug).catch(() => {})
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!(await getTeam(installationId, ORG, slug))) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  console.warn(`[test] team ${slug} still readable ${timeoutMs}ms after deletion`)
}

async function pendingInvitationIdsTo(email: string): Promise<bigint[]> {
  const octokit = getInstallationOctokit(installationId)
  const invitations = await octokit.paginate(octokit.rest.orgs.listPendingInvitations, {
    org: ORG,
    per_page: 100,
  })
  return invitations
    .filter((i) => i.email?.toLowerCase() === email.toLowerCase())
    .map((i) => BigInt(i.id))
}

/** Nothing addressed to the stand-in email may outlive a test, however it ended. */
async function cancelInvitationsTo(email: string): Promise<void> {
  const octokit = getInstallationOctokit(installationId)
  for (const id of await pendingInvitationIdsTo(email)) {
    await octokit.rest.orgs
      .cancelInvitation({ org: ORG, invitation_id: Number(id) })
      .catch(() => {})
  }
}

async function countOrgTeams(): Promise<number> {
  const octokit = getInstallationOctokit(installationId)
  const teams = await octokit.paginate(octokit.rest.teams.list, { org: ORG, per_page: 100 })
  return teams.length
}
