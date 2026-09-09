import { appAlert, applySession, db, expect, openSettingsTab, seedSession, test } from './fixtures'

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
  await openSettingsTab(page)
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
  await openSettingsTab(page)
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
  await openSettingsTab(page)

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
  await openSettingsTab(page)

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

test('the staff access panel names a TA who has not linked GitHub', async ({
  page,
  context,
}) => {
  /*
   * The failure this panel exists for. Making someone a TA in the app grants them
   * nothing on GitHub — repositories are created with the student as their only
   * collaborator — so a TA reports that every repository 404s and it looks like a
   * bug rather than a permission nobody granted.
   *
   * The subtler half is a TA who has an account here and never signed in with
   * GitHub: they cannot be added to a team at all, so the button can report success
   * while that person still sees nothing. Naming them is the whole point.
   */
  const { instructor } = await seedClassroom({ deadline: null })

  // Upsert, not create. seedClassroom deletes the classroom and cascades its
  // members, but the user survives — and `email` is unique, so a plain create passes
  // on a clean database and then fails on every run afterwards. This test passed in
  // isolation and broke the suite exactly once, which is the worst way to find out.
  const ta = await db.user.upsert({
    where: { email: 'unlinked-ta@e2e.invalid' },
    update: { name: 'Unlinked TA', githubLogin: null, githubId: null },
    create: {
      name: 'Unlinked TA',
      email: 'unlinked-ta@e2e.invalid',
      // No githubLogin and no githubId: signed up, never linked GitHub.
    },
  })
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: ta.id } },
    update: { role: 'TA' },
    create: { classroomId, userId: ta.id, role: 'TA' },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  const panel = page.getByRole('region', { name: 'Staff access' })
  await expect(panel).toBeVisible()

  // Not set up yet, and it says so rather than looking like it is working.
  await expect(panel.getByText('not set up')).toBeVisible()
  await expect(panel.getByText(/No linked GitHub account: Unlinked TA/)).toBeVisible()

  // The copy has to say that the app's TA role is not GitHub access, because that
  // assumption is what sends people looking in the wrong place.
  await expect(panel.getByText(/grants nothing on GitHub by itself/)).toBeVisible()

  // And that the grant covers the classroom, not just the assignment being viewed.
  // Scoping it to one assignment would mean pressing this once per assignment to
  // express a single fact about who the staff are.
  await expect(panel.getByText(/across all\s+assignments, not just this one/)).toBeVisible()
})

test('a TA who accepted the assignment keeps an enforceable deadline lock', async ({
  page,
  context,
}) => {
  /*
   * Accepting needs a claimed roster entry and any classroom role, so a TA can hold
   * a real repository — either by accepting before being promoted, or by claiming a
   * roster entry as staff.
   *
   * That collides with locking. The lock lowers their *direct collaborator*
   * permission to pull, and GitHub resolves access to the highest level across every
   * source of grant, so the staff team's push would override it: the row would read
   * locked while its owner kept pushing. The job therefore keeps the team off that
   * one repository, and the instructor page must not claim otherwise.
   */
  const { instructor } = await seedClassroom({
    deadline: new Date('2020-01-01T00:00:00'),
    lockOnDeadline: true,
  })

  const ta = await db.user.upsert({
    where: { email: 'grading-ta@e2e.invalid' },
    update: { name: 'Grading TA', githubLogin: 'e2e-grading-ta' },
    create: {
      name: 'Grading TA',
      email: 'grading-ta@e2e.invalid',
      githubLogin: 'e2e-grading-ta',
      githubId: '910999001',
    },
  })
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: ta.id } },
    update: { role: 'TA' },
    create: { classroomId, userId: ta.id, role: 'TA' },
  })

  // The TA's own submission, locked by a previous sweep.
  await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: ta.id,
      status: 'READY',
      fullName: `${ORG}/e2edl-ta-own`,
      htmlUrl: `https://github.com/${ORG}/e2edl-ta-own`,
      lockedAt: new Date(),
      deadlineSha: 'c'.repeat(40),
    },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // The repository is listed and shows as locked, which is the state the app must be
  // able to keep true rather than merely assert.
  await expect(page.getByRole('cell', { name: /Grading TA/ })).toBeVisible()
  await expect(page.getByText('locked', { exact: true }).first()).toBeVisible()

  await openSettingsTab(page)
  await expect(
    page.getByText('1 repository is currently read-only because the deadline passed.'),
  ).toBeVisible()
})

test('the staff panel counts every repository in the classroom, not just this assignment', async ({
  page,
  context,
}) => {
  /*
   * A course a few weeks in has repositories spread over several assignments. The
   * panel first counted only the assignment being viewed, which understated the work
   * — a 40-repository course reading as 12 — and the missing ones would have been the
   * older assignments nobody thinks to revisit.
   */
  const { instructor } = await seedClassroom({ deadline: null })

  const second = await db.assignment.create({
    data: {
      classroomId,
      title: 'E2E Staff Second Assignment',
      slug: 'e2e-staff-second',
      type: 'INDIVIDUAL',
      repoPrefix: 'e2edl2',
      publishedAt: new Date(),
    },
  })

  // Two repositories on this assignment, one on the other. All three are in scope.
  for (const [i, assignment] of [assignmentId, assignmentId, second.id].entries()) {
    const student = await seedSession(`e2e-staff-count-${i}`)
    await db.assignmentRepo.create({
      data: {
        assignmentId: assignment,
        userId: student.id,
        status: 'READY',
        fullName: `${ORG}/e2edl-count-${i}`,
      },
    })
  }

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)
  await openSettingsTab(page)

  const panel = page.getByRole('region', { name: 'Staff access' })
  await expect(panel.getByText('Repositories, 2 assignments')).toBeVisible()
  await expect(panel.getByText('3', { exact: true })).toBeVisible()
})

test('a student never sees the staff access panel', async ({ page, context }) => {
  const { student } = await seedClassroom({ deadline: null })
  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  await expect(page.getByRole('region', { name: 'Staff access' })).toHaveCount(0)
})

test('the staff page separates repositories from settings, and the tabs work by keyboard', async ({
  page,
  context,
}) => {
  const { instructor } = await seedClassroom({ deadline: new Date('2026-10-01T23:59:00') })
  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  const tablist = page.getByRole('tablist', { name: 'Assignment views' })
  await expect(tablist).toBeVisible()

  // Repositories leads, because it is what staff open the page to look at.
  const repositories = page.getByRole('tab', { name: /Repositories/ })
  const settings = page.getByRole('tab', { name: 'Settings' })
  await expect(repositories).toHaveAttribute('aria-selected', 'true')
  await expect(settings).toHaveAttribute('aria-selected', 'false')

  // Settings content is present but not shown until its tab is selected.
  await expect(page.getByRole('heading', { name: 'Deadline', exact: true })).toBeHidden()

  /*
   * Arrow keys move between tabs. This is the half of the ARIA tabs pattern that
   * gets left out when tabs are built from buttons and state, and nothing about
   * clicking would reveal its absence.
   */
  await repositories.focus()
  await page.keyboard.press('ArrowRight')
  await expect(settings).toHaveAttribute('aria-selected', 'true')
  await expect(settings).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Deadline', exact: true })).toBeVisible()

  // Wraps back around, and Home returns to the first tab.
  await page.keyboard.press('ArrowRight')
  await expect(repositories).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(settings).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(repositories).toHaveAttribute('aria-selected', 'true')

  // Only the selected tab is in the tab order, so Tab leaves the strip rather than
  // walking through every tab.
  await expect(repositories).toHaveAttribute('tabindex', '0')
  await expect(settings).toHaveAttribute('tabindex', '-1')
})

test('a student sees no tabs on the assignment page', async ({ page, context }) => {
  const { student } = await seedClassroom({ deadline: new Date('2026-10-01T23:59:00') })
  await applySession(context, student)
  await page.goto(`/classrooms/${SLUG}/assignments/${assignmentId}`)

  // The split is a staff affordance; a student has one view and should not be asked
  // to choose between it and an empty one.
  await expect(page.getByRole('tablist')).toHaveCount(0)
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
