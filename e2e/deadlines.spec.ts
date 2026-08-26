import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Deadline and extension management through the browser.
 *
 * No GitHub calls are needed: the sweep's effect on real repositories is verified
 * separately in the integration suite. What matters here is that an instructor can
 * set a deadline, grant an extension, and see the state honestly reflected.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2edeadline-fall-2026'

let classroomId: string
let assignmentId: string
let studentUserId: string

async function seedClassroom(opts: { deadline?: Date | null; lockOnDeadline?: boolean } = {}) {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Deadline Course',
      courseCode: 'E2EDL',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      assignments: {
        create: {
          title: 'E2E Deadline Assignment',
          slug: 'e2e-deadline-assignment',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: 'verify-template',
          repoPrefix: 'e2edl',
          deadline: opts.deadline ?? null,
          lockOnDeadline: opts.lockOnDeadline ?? false,
          publishedAt: new Date(),
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id

  const student = await seedSession('e2e-dl-student')
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: 'Late, Larry',
      sisUserId: '39700001',
      sisLoginId: 'dl700001',
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

test('instructor sets a deadline and enables locking', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByRole('heading', { name: 'Deadline', exact: true })).toBeVisible()
  await expect(page.getByText('No deadline set — nothing is ever marked late.')).toBeVisible()

  await page.getByLabel('Due').fill('2026-12-15T23:59')
  await page.getByLabel(/Revoke write access at the deadline/).check()
  await page.getByRole('button', { name: 'Save deadline' }).click()

  await expect(page.getByRole('status')).toContainText('Deadline saved.')

  const saved = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })
  expect(saved.lockOnDeadline).toBe(true)
  expect(saved.deadline).not.toBeNull()
  // Stored as the instructor's local wall-clock time, not shifted to UTC.
  expect(saved.deadline!.getFullYear()).toBe(2026)
  expect(saved.deadline!.getMonth()).toBe(11)
  expect(saved.deadline!.getDate()).toBe(15)
  expect(saved.deadline!.getHours()).toBe(23)
  expect(saved.deadline!.getMinutes()).toBe(59)

  // Reloading shows the same time back, which is the round-trip that a UTC
  // formatter would break.
  await page.reload()
  await expect(page.getByLabel('Due')).toHaveValue('2026-12-15T23:59')
})

test('instructor grants, updates and withdraws an extension', async ({ page, context }) => {
  const { instructor } = await seedClassroom({
    deadline: new Date('2026-10-01T23:59:00'),
    lockOnDeadline: true,
  })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await expect(page.getByText('No extensions granted.')).toBeVisible()

  // The student is offered by roster name.
  await page.getByLabel('Student or team').selectOption({ label: 'Late, Larry' })
  await page.getByLabel('New deadline').fill('2026-10-08T23:59')
  await page.getByLabel('Reason').fill('Medical documentation provided')
  await page.getByRole('button', { name: 'Grant extension' }).click()

  await expect(page.getByRole('status')).toContainText('Extension granted.')
  await expect(page.getByText('1 extension in force.')).toBeVisible()
  await expect(page.getByText(/Medical documentation provided/)).toBeVisible()

  const granted = await db.extension.findFirstOrThrow({ where: { assignmentId } })
  expect(granted.userId).toBe(studentUserId)
  expect(granted.reason).toBe('Medical documentation provided')

  // Granting again for the same student updates rather than duplicating.
  await page.getByLabel('Student or team').selectOption({ label: 'Late, Larry' })
  await page.getByLabel('New deadline').fill('2026-10-15T23:59')
  await page.getByRole('button', { name: 'Grant extension' }).click()
  await expect(page.getByRole('status')).toContainText('Extension granted.')

  const all = await db.extension.findMany({ where: { assignmentId } })
  expect(all).toHaveLength(1)
  expect(all[0].newDeadline.getDate()).toBe(15)

  // Both the grant and the update are audited.
  const audits = await db.auditLog.findMany({
    where: { classroomId, action: { in: ['extension.grant', 'extension.update'] } },
  })
  expect(audits.length).toBeGreaterThanOrEqual(2)

  // Withdraw.
  await page.getByRole('button', { name: 'Withdraw' }).click()
  await expect(page.getByRole('status')).toContainText('Extension withdrawn.')
  expect(await db.extension.count({ where: { assignmentId } })).toBe(0)
})

test('an extension needs both a target and a date', async ({ page, context }) => {
  const { instructor } = await seedClassroom({ deadline: new Date('2026-10-01T23:59:00') })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  const grant = page.getByRole('button', { name: 'Grant extension' })
  await expect(grant).toBeDisabled()

  await page.getByLabel('Student or team').selectOption({ label: 'Late, Larry' })
  await expect(grant).toBeDisabled()

  await page.getByLabel('New deadline').fill('2026-10-08T23:59')
  await expect(grant).toBeEnabled()
})

test('the locked-repository count is surfaced to the instructor', async ({ page, context }) => {
  const { instructor } = await seedClassroom({
    deadline: new Date('2020-01-01T00:00:00'),
    lockOnDeadline: true,
  })

  // Two repositories, one already locked by a previous sweep.
  await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: studentUserId,
      status: 'READY',
      fullName: `${ORG}/e2edl-dl700001`,
      lockedAt: new Date(),
      deadlineSha: 'a'.repeat(40),
    },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  await expect(
    page.getByText('1 repository is currently read-only because the deadline passed.'),
  ).toBeVisible()
})

test('a student sees the commit recorded for them, and that it was late', async ({
  page,
  context,
}) => {
  const { student } = await seedClassroom({
    deadline: new Date('2020-01-01T00:00:00'),
    lockOnDeadline: false,
  })

  const sha = 'b'.repeat(40)
  await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: studentUserId,
      status: 'READY',
      fullName: `${ORG}/e2edl-dl700002`,
      htmlUrl: `https://github.com/${ORG}/e2edl-dl700002`,
      deadlineSha: sha,
      // Pushed well after the deadline, so this is late — judged on the push, not on
      // the fact that the deadline has since passed.
      lastPushedAt: new Date('2020-02-01T00:00:00'),
    },
  })

  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // The short sha links to the commit itself: a bare hex string tells a student
  // nothing they can act on.
  const link = page.getByRole('link', { name: sha.slice(0, 7) })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute(
    'href',
    `https://github.com/${ORG}/e2edl-dl700002/commit/${sha}`,
  )
  await expect(page.getByText('late', { exact: true })).toBeVisible()
})

test('a student whose repository had nothing by the deadline is told so plainly', async ({
  page,
  context,
}) => {
  const { student } = await seedClassroom({ deadline: new Date('2020-01-01T00:00:00') })

  await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: studentUserId,
      status: 'READY',
      fullName: `${ORG}/e2edl-dl700003`,
      htmlUrl: `https://github.com/${ORG}/e2edl-dl700003`,
      // The sweep looked and found no commit old enough. Distinct from null, which
      // would mean it has not looked yet, and must not read as a missing feature.
      deadlineSha: '',
    },
  })

  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  await expect(page.getByText(/No commit was recorded/)).toBeVisible()
})

test('a student cannot grant themselves an extension', async ({ page, context }) => {
  const { student } = await seedClassroom({ deadline: new Date('2026-10-01T23:59:00') })
  await applySession(context, student)

  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // The whole deadline panel is staff-only.
  await expect(page.getByRole('heading', { name: 'Deadline', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Student or team')).toHaveCount(0)
  await expect(appAlert(page)).toHaveCount(0)
})
