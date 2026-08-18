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
  // Remove any classroom left by a previous run so the org is selectable again.
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

  // The real installation must be offered.
  const orgSelect = page.getByLabel('GitHub organization')
  await expect(orgSelect.locator('option', { hasText: ORG })).toHaveCount(1)
  await orgSelect.selectOption({ label: ORG })

  await page.getByLabel('Classroom name').fill(CLASSROOM_NAME)
  await page.getByLabel('Course code').fill(COURSE_CODE)
  await page.getByLabel('Term').fill(TERM)
  await page.getByRole('button', { name: 'Create classroom' }).click()

  // Slug is derived from course code and term, not the name.
  await page.waitForURL(new RegExp(`/classrooms/${EXPECTED_SLUG}`))
  await expect(page.getByRole('heading', { name: CLASSROOM_NAME })).toBeVisible()
  await expect(page.getByText('No assignments yet')).toBeVisible()

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

  // --- Duplicate org is refused ------------------------------------------
  await page.goto('/classrooms/new')
  // The org now backs a classroom, so it must no longer be offered.
  await expect(page.getByText('No GitHub organization available')).toBeVisible()

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
  // Staff-only controls are absent.
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)

  // Member with too low a role => 403.
  const settingsResponse = await page.goto(`/classrooms/${EXPECTED_SLUG}/settings`)
  expect(settingsResponse?.status()).toBe(403)

  // A signed-in non-member => 404, so classroom slugs are not enumerable.
  const outsider = await seedSession('e2e-outsider')
  await context.clearCookies()
  await applySession(context, outsider)

  const outsiderResponse = await page.goto(`/classrooms/${EXPECTED_SLUG}`)
  expect(outsiderResponse?.status()).toBe(404)
})
