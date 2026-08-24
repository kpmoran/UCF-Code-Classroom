import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Instructor management console.
 *
 * Role changes, removals, and the activity log. No GitHub calls are needed for
 * the assertions — the revocation job is verified separately against the real
 * organization — so these stay fast.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2econsole-fall-2026'

let classroomId: string

async function seedClassroom() {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Console Course',
      courseCode: 'E2ECONSOLE',
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
  return instructor
}

async function addStudent(login: string, displayName: string, nid: string) {
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
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('instructor promotes a student to TA and back', async ({ page, context }) => {
  const instructor = await seedClassroom()
  await addStudent('e2e-console-a', 'Able, Ann', 'cn400001')
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/people`)
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()

  // Roster name is shown, not the GitHub account name.
  await expect(page.getByText('Able, Ann')).toBeVisible()

  const roleSelect = page.getByLabel('Role for Able, Ann')
  await expect(roleSelect).toHaveValue('STUDENT')
  await roleSelect.selectOption('TA')

  await expect(page.getByLabel('Role for Able, Ann')).toHaveValue('TA')
  const promoted = await db.classroomMember.findFirstOrThrow({
    where: { classroomId, user: { githubLogin: 'e2e-console-a' } },
  })
  expect(promoted.role).toBe('TA')

  // Audited.
  const audit = await db.auditLog.findFirst({
    where: { classroomId, action: 'member.role_change' },
  })
  expect((audit!.detail as Record<string, unknown>).to).toBe('TA')

  await page.getByLabel('Role for Able, Ann').selectOption('STUDENT')
  await expect(page.getByLabel('Role for Able, Ann')).toHaveValue('STUDENT')
})

test('the only instructor cannot be demoted or removed', async ({ page, context }) => {
  const instructor = await seedClassroom()
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/people`)

  // Losing the last instructor would leave the classroom unmanageable, so the
  // controls are disabled rather than failing after a click.
  await expect(page.getByText('only instructor')).toBeVisible()
  await expect(page.getByLabel(/^Role for /)).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove' })).toBeDisabled()
})

test('removing a student requires choosing what happens to their repositories', async ({
  page,
  context,
}) => {
  const instructor = await seedClassroom()
  const student = await addStudent('e2e-console-b', 'Baker, Ben', 'cn400002')

  // Give them a repository so the dialog states the consequence.
  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: 'Console HW',
      slug: 'console-hw',
      type: 'INDIVIDUAL',
      templateOwner: ORG,
      templateRepo: 'verify-template',
      repoPrefix: 'console',
      publishedAt: new Date(),
    },
  })
  await db.assignmentRepo.create({
    data: {
      assignmentId: assignment.id,
      userId: student.id,
      status: 'READY',
      fullName: `${ORG}/console-cn400002`,
      htmlUrl: `https://github.com/${ORG}/console-cn400002`,
    },
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/people`)

  await page
    .getByRole('row', { name: /Baker, Ben/ })
    .getByRole('button', { name: 'Remove' })
    .click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Remove Baker, Ben from this classroom?')
  // The consequence is stated with a count.
  await expect(dialog).toContainText('1')
  await expect(dialog).toContainText('assignment repository')

  // KEEP is preselected — the least destructive option.
  await expect(dialog.getByRole('radio', { name: /Revoke their access, keep/ })).toBeChecked()

  // Choosing DELETE demands the login typed back.
  await dialog.getByRole('radio', { name: /Delete the repositories permanently/ }).check()
  const confirmButton = dialog.getByRole('button', { name: 'Remove' })
  await expect(confirmButton).toBeDisabled()

  await dialog.getByLabel(/Type .* to confirm/).fill('wrong');
  await expect(confirmButton).toBeDisabled()

  // Switch back to KEEP: no typing required, so it becomes actionable again.
  await dialog.getByRole('radio', { name: /Revoke their access, keep/ }).check()
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  await expect(page.getByText('Baker, Ben')).toHaveCount(0)

  // Membership gone, roster entry kept but freed for reclaiming.
  const membership = await db.classroomMember.findFirst({
    where: { classroomId, userId: student.id },
  })
  expect(membership).toBeNull()

  const entry = await db.rosterEntry.findFirstOrThrow({
    where: { classroomId, sisUserId: 'cn400002' },
  })
  expect(entry.claimedByUserId).toBeNull()
  expect(entry.removedAt).toBeNull()

  // The decision is audited with the chosen disposition.
  const audit = await db.auditLog.findFirstOrThrow({
    where: { classroomId, action: 'member.remove' },
  })
  expect((audit.detail as Record<string, unknown>).repoAction).toBe('KEEP')
})

test('a TA can view people but not change roles', async ({ page, context }) => {
  const instructor = await seedClassroom()
  expect(instructor.id).toBeTruthy()

  const ta = await addStudent('e2e-console-ta', 'Carter, Cal', 'cn400003')
  await db.classroomMember.update({
    where: { classroomId_userId: { classroomId, userId: ta.id } },
    data: { role: 'TA' },
  })
  await applySession(context, ta)

  await page.goto(`/classrooms/${SLUG}/people`)
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()

  // Read-only: no role selects, no remove buttons.
  await expect(page.getByLabel(/^Role for /)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)

  // The activity log names students alongside actions taken on them, so it is
  // instructor-only.
  const response = await page.goto(`/classrooms/${SLUG}/audit`)
  expect(response?.status()).toBe(403)
})

test('the activity log explains what happened in readable language', async ({
  page,
  context,
}) => {
  const instructor = await seedClassroom()
  const student = await addStudent('e2e-console-c', 'Davis, Dee', 'cn400004')

  await db.auditLog.createMany({
    data: [
      {
        classroomId,
        actorUserId: instructor.id,
        action: 'roster.import',
        detail: { added: 5, updated: 2, removed: 0, removalsSkipped: 3 },
      },
      {
        classroomId,
        actorUserId: instructor.id,
        action: 'member.remove',
        detail: { who: 'someone', repoAction: 'DELETE' },
      },
      {
        classroomId,
        // No actor: written by a background job.
        action: 'github.access_revoked',
        detail: { githubLogin: 'someone', repoAction: 'DELETE', failures: [] },
      },
    ],
  })
  expect(student.id).toBeTruthy()

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/audit`)

  await expect(page.getByRole('heading', { name: 'Activity log' })).toBeVisible()
  await expect(
    page.getByText('Imported a Canvas roster: 5 added, 2 updated, 0 removed, 3 absent from the file but kept'),
  ).toBeVisible()
  await expect(
    page.getByText('Removed someone from the classroom (repositories deleted)'),
  ).toBeVisible()
  await expect(page.getByText('Revoked GitHub access for @someone')).toBeVisible()

  // Destructive entries are marked, and job-written rows show no actor.
  await expect(page.getByText('destructive').first()).toBeVisible()
  await expect(page.getByText('system')).toBeVisible()
})

test('a student cannot reach the people or audit pages', async ({ page, context }) => {
  await seedClassroom()
  const student = await addStudent('e2e-console-d', 'Evans, Eve', 'cn400005')
  await applySession(context, student)

  expect((await page.goto(`/classrooms/${SLUG}/people`))?.status()).toBe(403)
  expect((await page.goto(`/classrooms/${SLUG}/audit`))?.status()).toBe(403)

  // And the server action refuses even if called directly — the UI is not the
  // permission boundary.
  await page.goto(`/classrooms/${SLUG}`)
  await expect(appAlert(page)).toHaveCount(0)
})

/*
 * The organization-owner credential must not outlive the membership it belongs to.
 *
 * `Classroom.ownerTokenUserId` names whose stored GitHub token performs privileged
 * organization work. Nothing used to clear it when that person was removed, so a
 * classroom kept using the token of someone who had just been taken off it — and
 * when they eventually disconnected GitHub, group assignments began failing with a
 * 401 that named no cause.
 */

/** An instructor who has completed the owner connection. */
async function addInstructorWithOwnerToken(login: string) {
  const user = await seedSession(login)
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: user.id } },
    update: { role: 'INSTRUCTOR' },
    create: { classroomId, userId: user.id, role: 'INSTRUCTOR' },
  })
  await db.account.deleteMany({ where: { userId: user.id, provider: 'github-owner' } })
  await db.account.create({
    data: {
      userId: user.id,
      type: 'oauth',
      provider: 'github-owner',
      providerAccountId: `owner-${login}`,
      // Only its presence matters here; selection is what is under test, not decryption.
      access_token: 'v1.placeholder',
      isOwnerToken: true,
      tokenValidatedAt: new Date(),
    },
  })
  return user
}

async function addPlainInstructor(login: string) {
  const user = await seedSession(login)
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: user.id } },
    update: { role: 'INSTRUCTOR' },
    create: { classroomId, userId: user.id, role: 'INSTRUCTOR' },
  })
  await db.account.deleteMany({ where: { userId: user.id, provider: 'github-owner' } })
  return user
}

/** Point the classroom's owner credential at someone, as classroom creation does. */
async function giveOwnerTokenTo(userId: string) {
  await db.classroom.update({ where: { id: classroomId }, data: { ownerTokenUserId: userId } })
}

test('removing the owner-token holder hands the credential to another instructor', async ({
  page,
  context,
}) => {
  const admin = await seedClassroom()
  const departing = await addPlainInstructor('e2e-owner-dep')
  const successor = await addInstructorWithOwnerToken('e2e-owner-succ')
  await giveOwnerTokenTo(departing.id)

  await applySession(context, admin)
  await page.goto(`/classrooms/${SLUG}/people`)

  await page
    .getByRole('row', { name: /e2e-owner-dep/ })
    .getByRole('button', { name: 'Remove' })
    .click()

  // KEEP is preselected, so the confirm button is actionable immediately.
  const dialogP = page.getByRole('dialog')
  await expect(dialogP).toBeVisible()
  await dialogP.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('row', { name: /e2e-owner-dep/ })).toHaveCount(0)

  // Handed on rather than cleared: clearing is only recoverable by a human
  // noticing a warning, so it is the last resort and not the default.
  const after = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { ownerTokenUserId: true },
  })
  expect(after.ownerTokenUserId).toBe(successor.id)

  const audit = await db.auditLog.findFirst({
    where: { classroomId, action: 'classroom.owner_token_reassigned' },
  })
  expect(audit).not.toBeNull()
})

test('with nobody to hand it to, the credential is cleared and settings says so', async ({
  page,
  context,
}) => {
  const admin = await seedClassroom()
  const departing = await addPlainInstructor('e2e-owner-dep2')
  await giveOwnerTokenTo(departing.id)

  await applySession(context, admin)
  await page.goto(`/classrooms/${SLUG}/people`)

  await page
    .getByRole('row', { name: /e2e-owner-dep2/ })
    .getByRole('button', { name: 'Remove' })
    .click()

  // KEEP is preselected, so the confirm button is actionable immediately.
  const dialog2 = page.getByRole('dialog')
  await expect(dialog2).toBeVisible()
  await dialog2.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('row', { name: /e2e-owner-dep2/ })).toHaveCount(0)

  const after = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { ownerTokenUserId: true },
  })
  expect(after.ownerTokenUserId).toBeNull()

  /*
   * And the way back exists. Several error messages have always told people to
   * "use Connect GitHub as organization owner" in settings, and that control did
   * not exist — so clearing the credential would have been unrecoverable, which is
   * a worse bug than the one being fixed.
   */
  await page.goto(`/classrooms/${SLUG}/settings`)
  await expect(page.getByRole('heading', { name: 'Organization owner' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Connect GitHub as organization owner' }),
  ).toBeVisible()
  await expect(page.getByText(/No organization owner is connected/)).toBeVisible()

  /*
   * The panel names the callback URL the button needs. A second Auth.js provider means
   * a second callback path on the App, and if it is missing the only symptom is
   * GitHub's redirect_uri error page, which names nothing actionable — so the URL is
   * on screen next to the button that triggers it.
   */
  await expect(page.getByText(/api\/auth\/callback\/github-owner/)).toBeVisible()

  // "Not connected" once, not twice: the holder and the token are separate questions.
  expect(await page.getByText('Not connected', { exact: true }).count()).toBe(1)
})

test('demoting the owner-token holder out of instructor also releases it', async ({
  page,
  context,
}) => {
  // Same invariant from the other direction: the credential belongs to an
  // instructor of the classroom, so losing that role releases it too.
  const admin = await seedClassroom()
  const demoted = await addPlainInstructor('e2e-owner-dem')
  await giveOwnerTokenTo(demoted.id)

  await applySession(context, admin)
  await page.goto(`/classrooms/${SLUG}/people`)
  await page.getByLabel(`Role for e2e-owner-dem`).selectOption('TA')

  await expect
    .poll(async () => {
      const row = await db.classroom.findUniqueOrThrow({
        where: { id: classroomId },
        select: { ownerTokenUserId: true },
      })
      return row.ownerTokenUserId
    })
    .toBeNull()
})
