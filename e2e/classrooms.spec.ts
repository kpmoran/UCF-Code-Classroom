import { applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Classroom lifecycle, driven through the browser so the server actions are
 * genuinely exercised: validation, redirect, revalidation, and the typed
 * confirmation on archiving.
 *
 * Uses the real sandbox GitHub organization, because the whole point of the
 * create flow is that it validates the installation against GitHub.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const CLASSROOM_NAME = 'E2E Software Engineering'
const COURSE_CODE = 'E2E4331'
const TERM = 'Fall 2026'
const EXPECTED_SLUG = 'e2e4331-fall-2026'

test.beforeEach(async () => {
  // Remove any classroom left by a previous run: the slug is unique, so a leftover
  // row fails the create rather than the org being unavailable.
  await db.classroom.deleteMany({
    where: { OR: [{ slug: { startsWith: 'e2e4331' } }, { name: CLASSROOM_NAME }] },
  })
})

test.afterAll(async () => {
  await db.classroom.deleteMany({
    where: { OR: [{ slug: { startsWith: 'e2e4331' } }, { name: CLASSROOM_NAME }] },
  })
  await db.$disconnect()
})

test('instructor creates a classroom, edits settings, and archives it', async ({
  page,
  context,
}) => {
  const user = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, user)

  // --- Create -------------------------------------------------------------
  await page.goto('/classrooms/new')
  await expect(page.getByRole('heading', { name: 'New classroom' })).toBeVisible()

  // The real installation must be offered. Selected by value, not by label: an
  // organization is allowed to host other classrooms, and when it does the label
  // carries an "already hosts N" suffix, so matching the bare name would break the
  // moment this suite runs against a database that has anything else in it.
  const orgSelect = page.getByLabel('GitHub organization')
  const orgOption = orgSelect.locator('option', { hasText: ORG })
  await expect(orgOption).toHaveCount(1)
  await orgSelect.selectOption((await orgOption.getAttribute('value'))!)

  await page.getByLabel('Classroom name').fill(CLASSROOM_NAME)
  await page.getByLabel('Course code').fill(COURSE_CODE)
  await page.getByLabel('Term').fill(TERM)
  await page.getByRole('button', { name: 'Create classroom' }).click()

  // Slug is derived from course code and term, not the name.
  await page.waitForURL(new RegExp(`/classrooms/${EXPECTED_SLUG}`))
  await expect(page.getByRole('heading', { name: CLASSROOM_NAME })).toBeVisible()
  await expect(page.getByText('No assignments yet')).toBeVisible()

  // Sharing the link is the first thing you do with a new classroom, so it is on the
  // page you land on rather than in settings.
  await expect(page.getByLabel('Invite link')).toHaveValue(/\/join\/[A-Za-z0-9_-]+$/)
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()

  const created = await db.classroom.findUnique({ where: { slug: EXPECTED_SLUG } })
  expect(created).not.toBeNull()
  expect(created?.githubOrgLogin).toBe(ORG)

  // The creator is enrolled as instructor and an invite link exists.
  const membership = await db.classroomMember.findFirst({
    where: { classroomId: created!.id, userId: user.id },
  })
  expect(membership?.role).toBe('INSTRUCTOR')

  const invite = await db.inviteLink.findFirst({ where: { classroomId: created!.id } })
  expect(invite?.token).toBeTruthy()

  // The action is audited.
  const audit = await db.auditLog.findFirst({
    where: { classroomId: created!.id, action: 'classroom.create' },
  })
  expect(audit).not.toBeNull()

  // --- A second classroom may share the org -------------------------------
  /*
   * This assertion used to be the exact opposite: an org backing a classroom was
   * removed from the list. The stated reason was colliding repository names, which
   * dedupeRepoName had always handled by suffixing against the live org repo list —
   * so the rule prevented nothing and cost a lot. It meant one organization per
   * course, and next term's run of the same course needed a whole new organization.
   *
   * So the org stays selectable, and says what it already holds.
   */
  await page.goto('/classrooms/new')
  await expect(page.getByText('No GitHub organization available')).toHaveCount(0)
  await expect(
    page.getByRole('option', { name: new RegExp(`${ORG}.*already hosts \\d+ classroom`) }),
  ).toHaveCount(1)

  /*
   * And it goes all the way through, not just as far as the dropdown. The rule existed
   * twice — in the picker and again in createClassroom — and removing only the first
   * left the org selectable but the submit still refused, which is a worse state than
   * before. So this drives the real form rather than asserting on the options.
   */
  const SECOND_TERM = 'Spring 2027'
  const SECOND_SLUG = 'e2e4331-spring-2027'
  // By value, not label: the label now carries the "already hosts" suffix.
  const secondSelect = page.getByLabel('GitHub organization')
  const orgValue = await secondSelect
    .locator('option', { hasText: ORG })
    .first()
    .getAttribute('value')
  expect(orgValue).toBeTruthy()
  await secondSelect.selectOption(orgValue!)
  await page.getByLabel('Classroom name').fill('E2E Software Engineering II')
  await page.getByLabel('Course code').fill(COURSE_CODE)
  await page.getByLabel('Term').fill(SECOND_TERM)
  await page.getByRole('button', { name: 'Create classroom' }).click()

  await page.waitForURL(new RegExp(`/classrooms/${SECOND_SLUG}`))
  const second = await db.classroom.findUnique({ where: { slug: SECOND_SLUG } })
  expect(second?.githubOrgLogin).toBe(ORG)
  // Same org, two classrooms, distinguished by the term in the slug.
  expect(second?.id).not.toBe(created!.id)

  // --- Settings -----------------------------------------------------------
  await page.goto(`/classrooms/${EXPECTED_SLUG}/settings`)
  await expect(page.getByRole('heading', { name: 'Classroom settings' })).toBeVisible()

  // Live org-ownership check should confirm kpmoran is an owner.
  await expect(page.getByText('You are an organization Owner')).toBeVisible()

  // The invite link is shown and points at the join route.
  await expect(page.getByRole('textbox', { name: 'Invite link' })).toHaveValue(
    new RegExp(`/join/${invite!.token}$`),
  )

  await page.getByLabel('Classroom name').fill('E2E Software Engineering (renamed)')
  await page.getByLabel('Default student access').selectOption('MAINTAIN')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()

  const updated = await db.classroom.findUnique({ where: { slug: EXPECTED_SLUG } })
  expect(updated?.name).toBe('E2E Software Engineering (renamed)')
  expect(updated?.defaultStudentPermission).toBe('MAINTAIN')
  // Renaming must not move the URL — invite links are already out.
  expect(updated?.slug).toBe(EXPECTED_SLUG)

  // --- Archive requires the slug typed exactly ---------------------------
  const archiveButton = page.getByRole('button', { name: 'Archive classroom' })
  await expect(archiveButton).toBeDisabled()

  await page.getByLabel(/Type .* to confirm/).fill('wrong-slug')
  await expect(archiveButton).toBeDisabled()

  await page.getByLabel(/Type .* to confirm/).fill(EXPECTED_SLUG)
  await expect(archiveButton).toBeEnabled()
  await archiveButton.click()

  await expect(page.getByRole('button', { name: 'Restore classroom' })).toBeVisible()
  const archived = await db.classroom.findUnique({ where: { slug: EXPECTED_SLUG } })
  expect(archived?.archivedAt).not.toBeNull()

  // Archived state is surfaced to students on the classroom page.
  await page.goto(`/classrooms/${EXPECTED_SLUG}`)
  await expect(page.getByText('This classroom is archived.')).toBeVisible()
})

test('a student cannot reach instructor settings, and a non-member gets 404', async ({
  page,
  context,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })

  const classroom = await db.classroom.create({
    data: {
      name: CLASSROOM_NAME,
      courseCode: COURSE_CODE,
      term: TERM,
      slug: EXPECTED_SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
    },
  })

  // A signed-in student who IS a member: sees the classroom, not the settings.
  const student = await seedSession('e2e-student-1')
  await db.classroomMember.create({
    data: { classroomId: classroom.id, userId: student.id, role: 'STUDENT' },
  })
  await applySession(context, student)

  await page.goto(`/classrooms/${EXPECTED_SLUG}`)
  await expect(page.getByRole('heading', { name: CLASSROOM_NAME })).toBeVisible()
  // Staff-only controls are absent. The classroom page is shared with students, so
  // the invite bar has to be gated rather than merely placed somewhere staff-ish.
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByLabel('Invite link')).toHaveCount(0)

  /*
   * Member with too low a role => 403, on every staff route.
   *
   * The status is asserted, not just the absence of content, because the two can
   * come apart. Giving a route a `loading.tsx` makes Next flush that shell — with a
   * 200 — before the page component runs, so the `forbidden()` inside it can no
   * longer set the status: the body is correct and the status lies. Anything reading
   * the status rather than the body (monitoring, a crawler, a fetch in a script)
   * would be told the request succeeded.
   *
   * Both staff routes are listed so that adding a loading state to either one is
   * caught here rather than in production.
   */
  for (const route of ['settings', 'assignments/new']) {
    const response = await page.goto(`/classrooms/${EXPECTED_SLUG}/${route}`)
    expect(response?.status(), `GET /${route} as a student`).toBe(403)
    // And nothing staff-only leaked into the body either way.
    await expect(page.getByRole('heading', { name: 'Classroom settings' })).toHaveCount(0)
    await expect(page.getByLabel('Repository name prefix')).toHaveCount(0)
  }

  // A signed-in non-member => 404, so classroom slugs are not enumerable.
  const outsider = await seedSession('e2e-outsider')
  await context.clearCookies()
  await applySession(context, outsider)

  const outsiderResponse = await page.goto(`/classrooms/${EXPECTED_SLUG}`)
  expect(outsiderResponse?.status()).toBe(404)
})
