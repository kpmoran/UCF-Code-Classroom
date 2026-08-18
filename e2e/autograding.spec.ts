import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Autograding configuration through the browser.
 *
 * The workflow's behaviour on a real runner is verified in the integration suite;
 * these tests cover the instructor's side — configuring tests, seeing scores, and
 * being warned when a run looks tampered with.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2eag-fall-2026'

let classroomId: string
let assignmentId: string
let studentUserId: string

async function seedClassroom(opts: { autograde?: boolean } = {}) {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Autograde Course',
      courseCode: 'E2EAG',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      assignments: {
        create: {
          title: 'E2E Autograde Assignment',
          slug: 'e2e-autograde-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: 'verify-template',
          repoPrefix: 'e2eag',
          autogradeEnabled: opts.autograde ?? false,
          publishedAt: new Date(),
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id

  const student = await seedSession('e2e-ag-student')
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: 'Grade, Gary',
      sisUserId: '39900001',
      sisLoginId: 'ag900001',
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })
  studentUserId = student.id

  return { instructor, student }
}

test.afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('instructor configures grading tests', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByRole('heading', { name: 'Autograding' })).toBeVisible()
  await expect(page.getByText('disabled')).toBeVisible()

  await page.getByLabel('Enable autograding').check()
  await page.getByRole('button', { name: 'Add a test' }).click()

  await page.getByLabel('Test name').fill('Compiles')
  await page.getByLabel('Points').fill('20')
  await page.getByLabel('Setup command').fill('npm ci')
  await page.getByLabel('Test command').fill('npm run build')

  await page.getByRole('button', { name: 'Add a test' }).click()
  await page.getByLabel('Test name').nth(1).fill('Unit tests')
  await page.getByLabel('Points').nth(1).fill('80')
  await page.getByLabel('Test command').nth(1).fill('npm test')

  // The running total is shown as points are entered.
  await expect(page.getByText('100 points')).toBeVisible()

  await page.getByRole('button', { name: 'Save autograding' }).click()
  await expect(page.getByRole('status')).toContainText('Saved.')

  const saved = await db.assignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { gradingTests: { orderBy: { order: 'asc' } } },
  })
  expect(saved.autogradeEnabled).toBe(true)
  expect(saved.totalPoints).toBe(100)
  expect(saved.gradingTests.map((t) => [t.name, t.points, t.order])).toEqual([
    ['Compiles', 20, 0],
    ['Unit tests', 80, 1],
  ])
  expect(saved.gradingTests[0].setupCommand).toBe('npm ci')

  // Configuration is audited.
  const audit = await db.auditLog.findFirstOrThrow({
    where: { classroomId, action: 'autograding.configure' },
  })
  expect((audit.detail as Record<string, unknown>).totalPoints).toBe(100)
})

test('duplicate test names are refused', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ autograde: true })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Add a test' }).click()
  }
  await page.getByLabel('Test name').nth(0).fill('Same name')
  await page.getByLabel('Test command').nth(0).fill('true')
  await page.getByLabel('Test name').nth(1).fill('Same name')
  await page.getByLabel('Test command').nth(1).fill('true')

  await page.getByRole('button', { name: 'Save autograding' }).click()

  // Duplicates would collide when reconciling a run against the config and read
  // ambiguously in a Canvas export.
  await expect(appAlert(page)).toContainText('Two tests are both called')
  expect(await db.gradingTest.count({ where: { assignmentId } })).toBe(0)
})

test('a test without a command is refused', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ autograde: true })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await page.getByRole('button', { name: 'Add a test' }).click()
  await page.getByLabel('Test name').fill('No command')
  await page.getByRole('button', { name: 'Save autograding' }).click()

  await expect(appAlert(page)).toContainText('command to run')
})

test('tests can be reordered and removed', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ autograde: true })
  await db.gradingTest.createMany({
    data: [
      { assignmentId, name: 'First', runCommand: 'true', points: 10, order: 0 },
      { assignmentId, name: 'Second', runCommand: 'true', points: 20, order: 1 },
    ],
  })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByLabel('Test name').nth(0)).toHaveValue('First')

  await page.getByRole('button', { name: 'Move test 2 up' }).click()
  await expect(page.getByLabel('Test name').nth(0)).toHaveValue('Second')

  await page.getByRole('button', { name: 'Save autograding' }).click()
  await expect(page.getByRole('status')).toContainText('Saved.')

  const reordered = await db.gradingTest.findMany({
    where: { assignmentId },
    orderBy: { order: 'asc' },
  })
  expect(reordered.map((t) => t.name)).toEqual(['Second', 'First'])

  // Remove one.
  await page.getByRole('button', { name: 'Remove test 1' }).click()
  await page.getByRole('button', { name: 'Save autograding' }).click()
  await expect(page.getByRole('status')).toContainText('Saved.')

  const remaining = await db.gradingTest.findMany({ where: { assignmentId } })
  expect(remaining.map((t) => t.name)).toEqual(['First'])
})

test('scores appear in the repository table, flagging a tampered run', async ({
  page,
  context,
}) => {
  const { instructor } = await seedClassroom({ autograde: true })

  const repo = await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: studentUserId,
      status: 'READY',
      githubRepoId: BigInt(999000111),
      fullName: `${ORG}/e2eag-ag900001`,
      htmlUrl: `https://github.com/${ORG}/e2eag-ag900001`,
    },
    select: { id: true },
  })

  await db.autogradeRun.create({
    data: {
      assignmentRepoId: repo.id,
      workflowRunId: BigInt(888000111),
      headSha: 'b'.repeat(40),
      status: 'COMPLETED',
      score: 45,
      maxScore: 100,
      // A discrepancy is what a modified workflow or manifest looks like.
      rawResults: { warnings: [], discrepancies: ['This run reports 500 points available'] },
    },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  await expect(page.getByText('45/100')).toBeVisible()
  // The score is still shown — it is the best number available — but flagged.
  await expect(page.getByText('check', { exact: true })).toBeVisible()
})

test('a failed run shows as having no results rather than a zero', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ autograde: true })

  const repo = await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: studentUserId,
      status: 'READY',
      githubRepoId: BigInt(999000222),
      fullName: `${ORG}/e2eag-ag900001`,
    },
    select: { id: true },
  })
  await db.autogradeRun.create({
    data: {
      assignmentRepoId: repo.id,
      workflowRunId: BigInt(888000222),
      headSha: '',
      status: 'FAILED',
      rawResults: { error: 'This run produced no autograding results.' },
    },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // A zero would read as "the student failed every test", which is a different
  // and much worse claim than "we have no results".
  await expect(page.getByText('no results')).toBeVisible()
  await expect(page.getByText('0/0')).toHaveCount(0)
})

test('students do not see the autograding configuration', async ({ page, context }) => {
  const { student } = await seedClassroom({ autograde: true })
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByRole('heading', { name: 'Autograding' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add a test' })).toHaveCount(0)
})
