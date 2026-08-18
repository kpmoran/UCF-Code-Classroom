import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'
import { deleteRepoIfExists, deleteTeamIfExists, getRepoInfo } from './github'

/**
 * Group assignment team formation, through the browser.
 *
 * The first test creates real GitHub resources (a team plus a repository) via the
 * worker. The rest exercise the formation rules, which need no GitHub calls, so
 * they stay fast.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2eteam-fall-2026'
const TEMPLATE = 'verify-template'
const PREFIX = 'e2eteam'

let classroomId: string
let assignmentId: string

async function cleanupGitHub() {
  const rows = await db.assignmentRepo.findMany({
    where: { assignment: { classroom: { slug: SLUG } }, fullName: { not: null } },
    select: { fullName: true },
  })
  for (const row of rows) {
    await deleteRepoIfExists(row.fullName!.split('/')[1])
  }

  const teams = await db.team.findMany({
    where: { assignment: { classroom: { slug: SLUG } }, githubTeamSlug: { not: null } },
    select: { githubTeamSlug: true },
  })
  for (const t of teams) {
    await deleteTeamIfExists(t.githubTeamSlug!)
  }
}

async function seedClassroom(opts: { maxTeams?: number; maxTeamSize?: number } = {}) {
  await cleanupGitHub()
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Team Course',
      courseCode: 'E2ETEAM',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      assignments: {
        create: {
          title: 'E2E Group Project',
          slug: 'e2e-group-project',
          type: 'GROUP',
          templateOwner: ORG,
          templateRepo: TEMPLATE,
          repoPrefix: PREFIX,
          visibility: 'PRIVATE',
          studentPermission: 'PUSH',
          maxTeams: opts.maxTeams ?? null,
          maxTeamSize: opts.maxTeamSize ?? null,
          publishedAt: new Date(),
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id
  return { instructor }
}

/** Enrol a student with a claimed roster entry so they may form teams. */
async function enrolStudent(login: string, displayName: string, nid: string) {
  const student = await seedSession(login)
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName,
      sisUserId: nid,
      sisLoginId: nid,
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })
  return student
}

test.afterAll(async () => {
  await cleanupGitHub()
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('a student creates a team and the worker provisions a real team repository', async ({
  page,
  context,
}) => {
  await seedClassroom({ maxTeamSize: 4 })
  // A real GitHub account, so the team membership call resolves.
  const student = await enrolStudent('kpmoran', 'Knight, Ava', 'tk300001')
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByRole('heading', { name: 'Join or create a team' })).toBeVisible()
  await expect(page.getByText('up to 4 members per team.')).toBeVisible()

  await page.getByLabel('New team name').fill('Knights')
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('heading', { name: 'Your team: Knights' })).toBeVisible()

  // The worker creates the GitHub team and repository.
  await expect(page.getByRole('link', { name: 'Open repository' })).toBeVisible({
    timeout: 120_000,
  })

  const repo = await db.assignmentRepo.findFirstOrThrow({
    where: { assignmentId },
    include: { team: true },
  })
  expect(repo.status).toBe('READY')
  expect(repo.fullName).toBe(`${ORG}/${PREFIX}-knights`)
  expect(repo.team?.githubTeamSlug).toBe(`${PREFIX}-knights`)

  // It really exists on GitHub.
  const remote = await getRepoInfo(`${PREFIX}-knights`)
  expect(remote).not.toBeNull()
  expect(remote?.private).toBe(true)

  // Membership state is surfaced, since a pending invite blocks pushing.
  const member = await db.teamMember.findFirstOrThrow({ where: { teamId: repo.teamId! } })
  expect(['active', 'pending']).toContain(member.githubMembershipState)

  // Once the repository exists, a student may not leave unilaterally.
  await expect(page.getByRole('button', { name: 'Leave team' })).toHaveCount(0)
})

test('a second student joins the existing team', async ({ page, context, browser }) => {
  await seedClassroom({ maxTeamSize: 4 })
  const first = await enrolStudent('e2e-team-a', 'Alpha, One', 'tk300002')

  // First student creates the team. No GitHub account behind this login, so
  // provisioning will warn rather than succeed — irrelevant to team formation.
  await applySession(context, first)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await page.getByLabel('New team name').fill('Squires')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: 'Your team: Squires' })).toBeVisible()

  // Second student sees it and joins.
  const second = await enrolStudent('e2e-team-b', 'Beta, Two', 'tk300003')
  const otherContext = await browser.newContext()
  await applySession(otherContext, second)
  const otherPage = await otherContext.newPage()

  await otherPage.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(otherPage.getByText('Existing teams')).toBeVisible()
  await expect(otherPage.getByText('Squires')).toBeVisible()
  await otherPage.getByRole('button', { name: 'Join' }).click()

  await expect(otherPage.getByRole('heading', { name: 'Your team: Squires' })).toBeVisible()
  await expect(otherPage.getByText('Alpha, One')).toBeVisible()

  const members = await db.teamMember.findMany({ where: { team: { assignmentId } } })
  expect(members).toHaveLength(2)

  // Only one repository row exists for the team — the late joiner did not create
  // a second one.
  const repos = await db.assignmentRepo.findMany({ where: { assignmentId } })
  expect(repos).toHaveLength(1)

  await otherContext.close()
})

test('a full team cannot be joined', async ({ page, context }) => {
  await seedClassroom({ maxTeamSize: 1 })
  const first = await enrolStudent('e2e-team-c', 'Gamma, Three', 'tk300004')

  const team = await db.team.create({
    data: {
      assignmentId,
      name: 'Solo',
      members: { create: { userId: first.id, role: 'LEADER' } },
    },
  })
  expect(team.id).toBeTruthy()

  const second = await enrolStudent('e2e-team-d', 'Delta, Four', 'tk300005')
  await applySession(context, second)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  // The cap is 1 and Solo has one member, so the button reads Full and is disabled.
  const joinButton = page.getByRole('button', { name: 'Full' })
  await expect(joinButton).toBeVisible()
  await expect(joinButton).toBeDisabled()
})

test('the team cap prevents creating another team', async ({ page, context }) => {
  await seedClassroom({ maxTeams: 1 })
  const first = await enrolStudent('e2e-team-e', 'Epsilon, Five', 'tk300006')
  await db.team.create({
    data: {
      assignmentId,
      name: 'OnlyTeam',
      members: { create: { userId: first.id, role: 'LEADER' } },
    },
  })

  const second = await enrolStudent('e2e-team-f', 'Zeta, Six', 'tk300007')
  await applySession(context, second)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  // Creation is not offered at all once the cap is reached.
  await expect(page.getByLabel('New team name')).toHaveCount(0)
  await expect(page.getByText('OnlyTeam')).toBeVisible()
})

test('a duplicate team name is refused with a useful message', async ({ page, context }) => {
  await seedClassroom()
  const first = await enrolStudent('e2e-team-g', 'Eta, Seven', 'tk300008')
  await db.team.create({
    data: {
      assignmentId,
      name: 'The Knights',
      members: { create: { userId: first.id, role: 'LEADER' } },
    },
  })

  const second = await enrolStudent('e2e-team-h', 'Theta, Eight', 'tk300009')
  await applySession(context, second)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // An exact duplicate invites joining instead.
  await page.getByLabel('New team name').fill('The Knights')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(appAlert(page)).toContainText('already exists')

  // A name that merely slugs the same is also refused, because the two would
  // share one GitHub team.
  await page.getByLabel('New team name').fill('the-knights')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(appAlert(page)).toContainText('too close to the existing team')
})

test('a student without a roster claim cannot form a team', async ({ page, context }) => {
  await seedClassroom()
  const student = await seedSession('e2e-team-unlinked')
  await db.classroomMember.create({
    data: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByText('Link your account first')).toBeVisible()
  await expect(page.getByLabel('New team name')).toHaveCount(0)
})
