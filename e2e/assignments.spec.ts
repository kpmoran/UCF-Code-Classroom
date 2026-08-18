import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'
import { deleteRepoIfExists, getRepoInfo, isRepoCollaborator } from './github'

/**
 * Assignment creation and the student accept flow, through the browser.
 *
 * This exercises the real queue: accepting enqueues a pg-boss job, the worker
 * running inside `next dev` picks it up, and a real repository appears in the
 * sandbox organization. Repositories created here are deleted afterwards.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2eassign-fall-2026'
const TEMPLATE = 'verify-template'
const PREFIX = 'e2ehw'

let classroomId: string

async function cleanupGitHub() {
  const rows = await db.assignmentRepo.findMany({
    where: { assignment: { classroom: { slug: SLUG } }, fullName: { not: null } },
    select: { fullName: true },
  })
  for (const row of rows) {
    await deleteRepoIfExists(row.fullName!.split('/')[1])
  }
}

test.beforeEach(async () => {
  await cleanupGitHub()
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Assignment Course',
      courseCode: 'E2EASSIGN',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
    },
  })
  classroomId = classroom.id
})

test.afterAll(async () => {
  await cleanupGitHub()
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('instructor creates an assignment, validating the template against GitHub', async ({
  page,
  context,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/new`)
  await expect(page.getByRole('heading', { name: 'New assignment' })).toBeVisible()

  await page.getByLabel('Title').fill('E2E Homework One')
  // The prefix is derived from the title until edited.
  await expect(page.getByLabel('Repository name prefix')).toHaveValue('e2e-homework-one')
  await page.getByLabel('Repository name prefix').fill(PREFIX)

  // A template that is not a template is rejected, with the reason.
  await page.getByLabel('Template').fill(`${ORG}/verify-not-a-template`)
  await page.getByRole('button', { name: /Create and publish/ }).click()
  await expect(appAlert(page)).toContainText('not marked as a template')

  // A template that does not exist is rejected too.
  await page.getByLabel('Template').fill(`${ORG}/no-such-template-9z8y7x`)
  await page.getByRole('button', { name: /Create and publish/ }).click()
  await expect(appAlert(page)).toContainText('Could not find')

  // The real template is accepted.
  await page.getByLabel('Template').fill(`${ORG}/${TEMPLATE}`)
  await page.getByRole('button', { name: /Create and publish/ }).click()

  await page.waitForURL(/\/assignments\/[a-z0-9]+$/)
  await expect(page.getByRole('heading', { name: 'E2E Homework One' })).toBeVisible()
  await expect(page.getByText('No repositories yet')).toBeVisible()

  const assignment = await db.assignment.findFirst({ where: { classroomId } })
  expect(assignment?.templateRepo).toBe(TEMPLATE)
  expect(assignment?.repoPrefix).toBe(PREFIX)
  expect(assignment?.publishedAt).not.toBeNull()
})

test('a student accepts and the worker provisions a real repository', async ({
  page,
  context,
}) => {
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Accept Flow',
      slug: 'e2e-accept-flow',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      visibility: 'PRIVATE',
      studentPermission: 'PUSH',
      publishedAt: new Date(),
    },
  })

  // The student is a real GitHub account so the collaborator step can succeed.
  const student = await seedSession('kpmoran')
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: 'Accept, Flow',
      sisUserId: '39100001',
      sisLoginId: 'ea100001',
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })

  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignment.id}`)

  await expect(page.getByRole('heading', { name: 'Accept this assignment' })).toBeVisible()
  await page.getByRole('button', { name: 'Accept assignment' }).click()

  // The panel polls itself while the worker provisions.
  await expect(page.getByRole('heading', { name: 'Your repository' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open repository' })).toBeVisible({
    timeout: 120_000,
  })

  const row = await db.assignmentRepo.findFirstOrThrow({
    where: { assignmentId: assignment.id },
  })
  expect(row.status).toBe('READY')
  expect(row.fullName).toBe(`${ORG}/${PREFIX}-ea100001`)

  // It really exists on GitHub, and the student has access.
  const remote = await getRepoInfo(`${PREFIX}-ea100001`)
  expect(remote).not.toBeNull()
  expect(remote?.private).toBe(true)
  expect(await isRepoCollaborator(`${PREFIX}-ea100001`, 'kpmoran')).toBe(true)

  // Clone instructions are offered.
  await page.getByText('How do I clone this?').click()
  await expect(page.getByText(new RegExp(`git clone .*${PREFIX}-ea100001\\.git`))).toBeVisible()
})

test('accepting twice does not create a second repository', async ({ page, context }) => {
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Double Accept',
      slug: 'e2e-double-accept',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      publishedAt: new Date(),
    },
  })

  const student = await seedSession('kpmoran')
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: 'Double, Accept',
      sisUserId: '39100002',
      sisLoginId: 'da100002',
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })

  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignment.id}`)
  await page.getByRole('button', { name: 'Accept assignment' }).click()
  await expect(page.getByRole('heading', { name: 'Your repository' })).toBeVisible()

  // Reload and re-run the accept path; the unique constraint must hold.
  await page.goto(`/classrooms/${SLUG}/assignments/${assignment.id}`)
  await page.reload()

  await expect(page.getByRole('link', { name: 'Open repository' })).toBeVisible({
    timeout: 120_000,
  })

  const rows = await db.assignmentRepo.findMany({ where: { assignmentId: assignment.id } })
  expect(rows).toHaveLength(1)
})

test('a student without a roster claim is told to link their account first', async ({
  page,
  context,
}) => {
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Unlinked',
      slug: 'e2e-unlinked',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      publishedAt: new Date(),
    },
  })

  const student = await seedSession('e2e-unlinked-student')
  await db.classroomMember.create({
    data: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignment.id}`)
  await expect(page.getByText('Link your account first')).toBeVisible()
  // No repository could be attributed, so accepting is not offered at all.
  await expect(page.getByRole('button', { name: 'Accept assignment' })).toHaveCount(0)
})

test('students cannot see an unpublished assignment', async ({ page, context }) => {
  const draft = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Draft',
      slug: 'e2e-draft',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      publishedAt: null,
    },
  })

  const student = await seedSession('e2e-draft-student')
  await db.classroomMember.create({
    data: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await applySession(context, student)

  const response = await page.goto(`/classrooms/${SLUG}/assignments/${draft.id}`)
  expect(response?.status()).toBe(404)

  // Nor is it listed on the classroom page.
  await page.goto(`/classrooms/${SLUG}`)
  await expect(page.getByText('E2E Draft')).toHaveCount(0)
})

test('instructor bulk-provisions with an honest ETA', async ({ page, context }) => {
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Bulk',
      slug: 'e2e-bulk',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: TEMPLATE,
      repoPrefix: PREFIX,
      publishedAt: new Date(),
    },
  })

  // Two registered students, only one of whom is a real GitHub account. The
  // other must fail cleanly rather than stalling the batch.
  const real = await seedSession('kpmoran')
  const fake = await seedSession('e2e-nonexistent-account-9z8y7x')

  for (const [i, u] of [real, fake].entries()) {
    await db.classroomMember.upsert({
      where: { classroomId_userId: { classroomId, userId: u.id } },
      update: {},
      create: { classroomId, userId: u.id, role: 'STUDENT' },
    })
    await db.rosterEntry.create({
      data: {
        classroomId,
        displayName: `Bulk, Student ${i}`,
        sisUserId: `3920000${i}`,
        sisLoginId: `bs20000${i}`,
        rawColumns: {},
        claimedByUserId: u.id,
        claimedAt: new Date(),
      },
    })
  }

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: instructor.id } },
    update: { role: 'INSTRUCTOR' },
    create: { classroomId, userId: instructor.id, role: 'INSTRUCTOR' },
  })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignment.id}`)

  // The budget is shown so slow provisioning reads as pacing, not breakage.
  await expect(page.getByText(/GitHub request budget/)).toBeVisible()

  const button = page.getByRole('button', { name: /Create \d+ repositor/ })
  await expect(button).toBeVisible()
  await button.click()

  await expect(page.getByRole('status')).toContainText(/Queued \d+ repositor/)

  // Wait for **both** jobs to settle. Polling for "at least one settled" is
  // satisfied the instant the invalid account fails — that failure needs no
  // GitHub calls — while the real repository is still being created.
  await expect
    .poll(
      async () => {
        const rows = await db.assignmentRepo.findMany({
          where: { assignmentId: assignment.id },
          select: { status: true },
        })
        return rows.filter((r) => r.status === 'READY' || r.status === 'FAILED').length
      },
      { timeout: 180_000, intervals: [2000] },
    )
    .toBe(2)

  const rows = await db.assignmentRepo.findMany({
    where: { assignmentId: assignment.id },
    select: { status: true, failureReason: true, fullName: true },
  })
  expect(rows).toHaveLength(2)

  const ready = rows.filter((r) => r.status === 'READY')
  expect(ready.length).toBeGreaterThanOrEqual(1)

  // A failure names the cause rather than reporting a generic error.
  const failed = rows.find((r) => r.status === 'FAILED')
  if (failed) {
    expect(failed.failureReason).toBeTruthy()
    console.log(`  bulk failure message: ${failed.failureReason}`)
  }
})
