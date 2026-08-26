import { appAlert, applySession, db, expect, openSettingsTab, seedSession, test } from './fixtures'

/**
 * Feedback pull request management through the browser.
 *
 * The behaviour on real repositories is verified in the integration suite; these
 * tests cover the instructor's view — in particular that a student who has not
 * pushed is shown as *waiting* rather than as a problem.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2efb-fall-2026'

let classroomId: string
let assignmentId: string

async function seedClassroom(opts: { feedbackPr?: boolean } = {}) {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Feedback Course',
      courseCode: 'E2EFB',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      assignments: {
        create: {
          title: 'E2E Feedback Assignment',
          slug: 'e2e-feedback-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: 'verify-template',
          repoPrefix: 'e2efb',
          feedbackPrEnabled: opts.feedbackPr ?? false,
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

/** A repository row in one of the three states the panel distinguishes. */
async function addRepo(opts: {
  login: string
  nid: string
  pushed: boolean
  prNumber?: number
}) {
  const student = await seedSession(opts.login)
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: `Student ${opts.nid}`,
      sisUserId: opts.nid,
      sisLoginId: opts.nid,
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })
  await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: student.id,
      status: 'READY',
      fullName: `${ORG}/e2efb-${opts.nid}`,
      htmlUrl: `https://github.com/${ORG}/e2efb-${opts.nid}`,
      lastPushedAt: opts.pushed ? new Date() : null,
      feedbackPrNumber: opts.prNumber ?? null,
    },
  })
  return student
}

test.afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('the panel distinguishes waiting from missing', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ feedbackPr: true })
  await addRepo({ login: 'e2e-fb-a', nid: 'fb100001', pushed: true, prNumber: 1 })
  await addRepo({ login: 'e2e-fb-b', nid: 'fb100002', pushed: true })
  await addRepo({ login: 'e2e-fb-c', nid: 'fb100003', pushed: false })
  await addRepo({ login: 'e2e-fb-d', nid: 'fb100004', pushed: false })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  await expect(page.getByRole('heading', { name: 'Feedback pull requests' })).toBeVisible()

  // One has a PR, one pushed and awaits one, two have not pushed. Conflating the
  // last two with the middle one would send the instructor chasing a non-problem.
  const panel = page.locator('div').filter({ hasText: 'With a pull request' }).last()
  await expect(panel).toContainText('1')
  await expect(page.getByText('Pushed, awaiting one')).toBeVisible()
  await expect(page.getByText('Not pushed yet')).toBeVisible()

  await expect(
    page.getByText(/Repositories in the last column are waiting for that, not/),
  ).toBeVisible()

  // The button offers exactly the actionable count.
  await expect(page.getByRole('button', { name: 'Open 1 missing pull request' })).toBeEnabled()
})

test('queueing missing pull requests reports what it did and did not do', async ({
  page,
  context,
}) => {
  const { instructor } = await seedClassroom({ feedbackPr: true })
  await addRepo({ login: 'e2e-fb-e', nid: 'fb100005', pushed: true })
  await addRepo({ login: 'e2e-fb-f', nid: 'fb100006', pushed: false })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  await page.getByRole('button', { name: /Open 1 missing pull request/ }).click()

  const status = page.getByRole('status')
  await expect(status).toContainText('Opening 1 pull request')
  // "Nothing happened for that student" is explained rather than left mysterious.
  await expect(status).toContainText('has not pushed yet')

  const audit = await db.auditLog.findFirstOrThrow({
    where: { classroomId, action: 'feedback_pr.backfill' },
  })
  expect((audit.detail as Record<string, unknown>).queued).toBe(1)
  expect((audit.detail as Record<string, unknown>).awaitingFirstPush).toBe(1)
})

test('turning the feature on backfills students who already pushed', async ({
  page,
  context,
}) => {
  const { instructor } = await seedClassroom({ feedbackPr: false })
  await addRepo({ login: 'e2e-fb-g', nid: 'fb100007', pushed: true })
  await addRepo({ login: 'e2e-fb-h', nid: 'fb100008', pushed: true })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  await expect(
    page.getByRole('region', { name: 'Feedback pull requests' }).getByText('off', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText(/opens a pull request for every student who has already pushed/),
  ).toBeVisible()

  await page
    .getByRole('region', { name: 'Feedback pull requests' })
    .getByRole('button', { name: 'Turn on' })
    .click()
  await expect(page.getByRole('status')).toContainText('Opening 2 pull requests')

  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })
  expect(assignment.feedbackPrEnabled).toBe(true)
})

test('turning the feature off is recorded and stops offering the backfill', async ({
  page,
  context,
}) => {
  const { instructor } = await seedClassroom({ feedbackPr: true })
  await addRepo({ login: 'e2e-fb-i', nid: 'fb100009', pushed: true })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  await page
    .getByRole('region', { name: 'Feedback pull requests' })
    .getByRole('button', { name: 'Turn off' })
    .click()
  await expect(
    page.getByRole('region', { name: 'Feedback pull requests' }).getByText('off', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Open \d+ missing/ })).toHaveCount(0)

  const audit = await db.auditLog.findFirst({
    where: { classroomId, action: 'feedback_pr.disable' },
  })
  expect(audit).not.toBeNull()
})

test('feedback pull request links appear in the repository table', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ feedbackPr: true })
  await addRepo({ login: 'e2e-fb-j', nid: 'fb100010', pushed: true, prNumber: 7 })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  const link = page.getByRole('link', { name: 'Feedback #7' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute(
    'href',
    `https://github.com/${ORG}/e2efb-fb100010/pull/7`,
  )
})

test('students see their own feedback pull request but no controls', async ({
  page,
  context,
}) => {
  await seedClassroom({ feedbackPr: true })
  const student = await addRepo({
    login: 'e2e-fb-student',
    nid: 'fb100011',
    pushed: true,
    prNumber: 3,
  })
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  await expect(page.getByRole('link', { name: 'Feedback pull request' })).toBeVisible()
  // The management panel is staff-only.
  await expect(page.getByRole('heading', { name: 'Feedback pull requests' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Turn off' })).toHaveCount(0)
  await expect(appAlert(page)).toHaveCount(0)
})
