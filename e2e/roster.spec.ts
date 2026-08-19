import { randomBytes } from 'node:crypto'

import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Roster import and student registration, end to end.
 *
 * The import is exercised through a real file upload so the multipart handling,
 * server-side re-parse and diff preview are all covered. The registration flow is
 * driven as a second signed-in user, which is the only way to prove the claim is
 * atomic and that a claimed name disappears for everyone else.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2eroster-fall-2026'

const CSV_INITIAL = `"Student","ID","SIS User ID","SIS Login ID","Section","Homework 1 (901234)"
"    Points Possible","","","","","10.0"
"Alvarez, Ava","4001","30000001","av123456","SEC-001","9.0"
"Bennett, Noah","4002","30000002","nb234567","SEC-001","10.0"
"Chen, Mia","4003","30000003","mc345678","SEC-002","8.5"
"Test Student","4999","","","SEC-001",""
`

// Ava dropped; Chen changed section; Duarte is new.
const CSV_UPDATED = `"Student","ID","SIS User ID","SIS Login ID","Section","Homework 1 (901234)"
"    Points Possible","","","","","10.0"
"Bennett, Noah","4002","30000002","nb234567","SEC-001","10.0"
"Chen, Mia","4003","30000003","mc345678","SEC-003","8.5"
"Duarte, Liam","4004","30000004","dl456789","SEC-002","7.0"
`

let classroomId: string
let inviteToken: string

test.beforeEach(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  inviteToken = randomBytes(24).toString('base64url')

  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Roster Course',
      courseCode: 'E2EROSTER',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      inviteLinks: { create: { token: inviteToken } },
    },
  })
  classroomId = classroom.id
})

test.afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('instructor imports a Canvas CSV, then re-imports with changes', async ({
  page,
  context,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/roster`)
  await expect(page.getByRole('heading', { name: 'Roster', exact: true })).toBeVisible()
  await expect(page.getByText('No roster yet')).toBeVisible()

  // --- First import -------------------------------------------------------
  await page.setInputFiles('#file', {
    name: 'gradebook.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV_INITIAL, 'utf8'),
  })
  await page.getByRole('button', { name: 'Preview changes' }).click()

  await expect(page.getByText('3 student rows parsed')).toBeVisible()

  // Identity columns were recognised.
  await expect(page.getByText('displayName: Student')).toBeVisible()
  await expect(page.getByText('sisUserId: SIS User ID')).toBeVisible()

  // Canvas metadata and the Student View account were skipped.
  await page.getByText('2 rows skipped').click()
  await expect(page.getByText(/Points Possible/)).toBeVisible()
  await expect(page.getByText(/Student View test account/)).toBeVisible()

  await expect(page.getByText('Will be added')).toBeVisible()
  await expect(page.getByText('Alvarez, Ava')).toBeVisible()

  // Nothing written yet.
  expect(await db.rosterEntry.count({ where: { classroomId } })).toBe(0)

  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText(/Imported: 3 added/)).toBeVisible()

  const afterFirst = await db.rosterEntry.findMany({
    where: { classroomId },
    orderBy: { displayName: 'asc' },
  })
  expect(afterFirst.map((e) => e.displayName)).toEqual([
    'Alvarez, Ava',
    'Bennett, Noah',
    'Chen, Mia',
  ])
  // Every source column is preserved for later Canvas grade export.
  expect(afterFirst[0].rawColumns).toMatchObject({
    Student: 'Alvarez, Ava',
    'SIS User ID': '30000001',
    'Homework 1 (901234)': '9.0',
  })

  // --- Re-import: one drop, one change, one addition ----------------------
  await page.reload()
  await page.setInputFiles('#file', {
    name: 'gradebook-week3.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV_UPDATED, 'utf8'),
  })
  await page.getByRole('button', { name: 'Preview changes' }).click()

  await expect(page.getByText('Will be added')).toBeVisible()
  await expect(page.getByText('Duarte, Liam')).toBeVisible()
  await expect(page.getByText(/section: SEC-002 → SEC-003/)).toBeVisible()
  await expect(
    page.getByText('1 student on the roster is not in this file'),
  ).toBeVisible()

  // Removals are opt-in and default to off.
  const removalCheckbox = page.getByRole('checkbox')
  await expect(removalCheckbox).not.toBeChecked()

  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText(/Imported: 1 added/)).toBeVisible()

  // Ava was NOT removed, because the box was left unticked.
  const ava = await db.rosterEntry.findFirst({
    where: { classroomId, displayName: 'Alvarez, Ava' },
  })
  expect(ava?.removedAt).toBeNull()

  const mia = await db.rosterEntry.findFirst({
    where: { classroomId, displayName: 'Chen, Mia' },
  })
  expect(mia?.section).toBe('SEC-003')

  // --- Re-import again, this time applying removals -----------------------
  await page.reload()
  await page.setInputFiles('#file', {
    name: 'gradebook-week3.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV_UPDATED, 'utf8'),
  })
  await page.getByRole('button', { name: 'Preview changes' }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Apply changes' }).click()
  // Scoped to the status message: the page header also mentions a removed count.
  await expect(page.getByRole('status')).toContainText('1 removed')

  const avaAfter = await db.rosterEntry.findFirst({
    where: { classroomId, displayName: 'Alvarez, Ava' },
  })
  // Soft delete, so a mistaken import stays recoverable.
  expect(avaAfter?.removedAt).not.toBeNull()
})

test('a wrong CSV warns about registered students it would remove', async ({
  page,
  context,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)

  // Seed a roster where one student has registered.
  const student = await seedSession('e2e-registered-student')
  await db.rosterEntry.createMany({
    data: [
      {
        classroomId,
        displayName: 'Alvarez, Ava',
        sisUserId: '30000001',
        sisLoginId: 'av123456',
        section: 'SEC-001',
        rawColumns: {},
      },
    ],
  })
  await db.rosterEntry.updateMany({
    where: { classroomId, sisUserId: '30000001' },
    data: { claimedByUserId: student.id, claimedAt: new Date() },
  })

  // Upload a CSV that does not contain Ava at all.
  await page.goto(`/classrooms/${SLUG}/roster`)
  await page.setInputFiles('#file', {
    name: 'wrong-section.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV_UPDATED, 'utf8'),
  })
  await page.getByRole('button', { name: 'Preview changes' }).click()

  // The consequence must be spelled out, naming the GitHub account.
  await expect(page.getByText('These students have already registered:')).toBeVisible()
  await expect(
    page.getByText(/Alvarez, Ava has registered as @e2e-registered-student/),
  ).toBeVisible()
  await expect(
    page.getByText(/you may have exported the wrong section or term/),
  ).toBeVisible()
})

test('a student joins via invite link and the name becomes unavailable', async ({
  page,
  context,
  browser,
}) => {
  await db.rosterEntry.createMany({
    data: [
      {
        classroomId,
        displayName: 'Alvarez, Ava',
        sisUserId: '30000001',
        sisLoginId: 'av123456',
        section: 'SEC-001',
        rawColumns: {},
      },
      {
        classroomId,
        displayName: 'Bennett, Noah',
        sisUserId: '30000002',
        sisLoginId: 'nb234567',
        section: 'SEC-001',
        rawColumns: {},
      },
    ],
  })

  // Signed out, the invite page explains what is about to happen but shows no names.
  await page.goto(`/join/${inviteToken}`)
  await expect(page.getByText('Sign in with GitHub to continue')).toBeVisible()
  await expect(page.getByText('Alvarez, Ava')).toHaveCount(0)

  // Signed in, the student picks their own name.
  const student = await seedSession('e2e-ava')
  await applySession(context, student)
  await page.goto(`/join/${inviteToken}`)

  await expect(page.getByText('Join E2E Roster Course')).toBeVisible()
  // The NID is masked — the roster list is visible to anyone with the link.
  await expect(page.getByText('•••••456')).toBeVisible()
  await expect(page.getByText('av123456')).toHaveCount(0)

  const confirm = page.getByRole('button', { name: /This is me/ })
  await expect(confirm).toBeDisabled()

  await page.locator('form').getByRole('radio').first().check()
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await page.waitForURL(new RegExp(`/classrooms/${SLUG}`))
  await expect(page.getByRole('heading', { name: 'E2E Roster Course' })).toBeVisible()

  const claimed = await db.rosterEntry.findFirst({
    where: { classroomId, claimedByUserId: student.id },
  })
  expect(claimed?.displayName).toBe('Alvarez, Ava')

  // The student is enrolled as a STUDENT.
  const membership = await db.classroomMember.findFirst({
    where: { classroomId, userId: student.id },
  })
  expect(membership?.role).toBe('STUDENT')

  // Revisiting the invite link goes straight to the classroom.
  await page.goto(`/join/${inviteToken}`)
  await page.waitForURL(new RegExp(`/classrooms/${SLUG}`))

  // A second student no longer sees the claimed name.
  const other = await browser.newContext()
  const otherStudent = await seedSession('e2e-noah')
  await applySession(other, otherStudent)
  const otherPage = await other.newPage()
  await otherPage.goto(`/join/${inviteToken}`)

  await expect(otherPage.getByText('Bennett, Noah')).toBeVisible()
  await expect(otherPage.getByText('Alvarez, Ava')).toHaveCount(0)
  await expect(otherPage.getByText('1 classmate already joined.')).toBeVisible()
  await other.close()
})

test('instructor can unlink a mis-claimed entry, freeing it', async ({ page, context }) => {
  const student = await seedSession('e2e-wrongpick')
  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: 'Chen, Mia',
      sisUserId: '30000003',
      sisLoginId: 'mc345678',
      section: 'SEC-002',
      rawColumns: {},
      claimedByUserId: student.id,
      claimedAt: new Date(),
    },
  })
  await db.classroomMember.create({
    data: { classroomId, userId: student.id, role: 'STUDENT' },
  })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)

  await page.goto(`/classrooms/${SLUG}/roster`)
  await expect(page.getByText('@e2e-wrongpick')).toBeVisible()

  await page.getByRole('button', { name: 'Unlink' }).click()
  await expect(page.getByText('@e2e-wrongpick')).toHaveCount(0)

  const freed = await db.rosterEntry.findFirst({ where: { classroomId, sisUserId: '30000003' } })
  expect(freed?.claimedByUserId).toBeNull()

  // Audited.
  const audit = await db.auditLog.findFirst({
    where: { classroomId, action: 'roster.unlink' },
  })
  expect(audit).not.toBeNull()
})

test('an invalid or revoked invite link is refused without revealing anything', async ({
  page,
}) => {
  await page.goto('/join/totally-made-up-token')
  await expect(page.getByText('This link can’t be used')).toBeVisible()
  await expect(page.getByText(/not valid/)).toBeVisible()

  // A revoked link reports "replaced" rather than "no such link", but neither
  // discloses whether the token ever existed.
  await db.inviteLink.updateMany({ where: { token: inviteToken }, data: { revokedAt: new Date() } })
  await page.goto(`/join/${inviteToken}`)
  await expect(page.getByText(/has been replaced/)).toBeVisible()
})

test('instructor adds a single student by hand from settings', async ({ page, context }) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/settings`)

  await page.getByLabel('Name', { exact: true }).fill('Lateadd, Lena')
  await page.getByLabel('NID').fill('ll900101')
  await page.getByLabel('SIS user ID').fill('90010001')
  await page.getByLabel('Email').fill('lena@knights.ucf.edu')
  await page.getByLabel('Section').fill('COP4331-0002')
  await page.getByRole('button', { name: 'Add to roster' }).click()

  await expect(page.getByRole('status')).toContainText('Added Lateadd, Lena')

  const entry = await db.rosterEntry.findFirstOrThrow({
    where: { classroomId, sisUserId: '90010001' },
  })
  expect(entry.displayName).toBe('Lateadd, Lena')
  expect(entry.sisLoginId).toBe('ll900101')
  expect(entry.claimedByUserId).toBeNull()

  // The identity columns grade export reads back must all be present. A sparse
  // payload here would drop a column from the export for the entire class,
  // because exportGrades keeps a column only if some row actually has that key.
  expect(entry.rawColumns).toEqual({
    Student: 'Lateadd, Lena',
    ID: '',
    'SIS User ID': '90010001',
    'SIS Login ID': 'll900101',
    Section: 'COP4331-0002',
  })

  await page.goto(`/classrooms/${SLUG}/roster`)
  await expect(page.getByText('Lateadd, Lena')).toBeVisible()
})

test('a hand-added student can claim their own entry through the invite link', async ({
  page,
  context,
  browser,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/settings`)
  await page.getByLabel('Name', { exact: true }).fill('Claimant, Cara')
  await page.getByRole('button', { name: 'Add to roster' }).click()
  await expect(page.getByRole('status')).toContainText('Added Claimant, Cara')

  // The point of adding a roster entry rather than a member: the student links
  // their own GitHub account, so nobody has to guess which login is theirs.
  const studentContext = await browser.newContext()
  const student = await seedSession('e2e-manual-claimant')
  await applySession(studentContext, student)
  const studentPage = await studentContext.newPage()
  await studentPage.goto(`/join/${inviteToken}`)
  await expect(studentPage.getByText('Claimant, Cara')).toBeVisible()
  // Only one entry exists on this roster, so the first radio is hers.
  await studentPage.locator('form').getByRole('radio').first().check()
  const confirm = studentPage.getByRole('button', { name: /This is me/ })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await studentPage.waitForURL(new RegExp(`/classrooms/${SLUG}`))

  const claimed = await db.rosterEntry.findFirstOrThrow({
    where: { classroomId, displayName: 'Claimant, Cara' },
  })
  expect(claimed.claimedByUserId).toBe(student.id)
  await studentContext.close()
})

test('a duplicate SIS user ID is refused with a sentence, not a database error', async ({
  page,
  context,
}) => {
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/settings`)

  await page.getByLabel('Name', { exact: true }).fill('First, Fiona')
  await page.getByLabel('SIS user ID').fill('90010002')
  await page.getByRole('button', { name: 'Add to roster' }).click()
  await expect(page.getByRole('status')).toContainText('Added First, Fiona')

  await page.getByLabel('Name', { exact: true }).fill('Second, Sam')
  await page.getByLabel('SIS user ID').fill('90010002')
  await page.getByRole('button', { name: 'Add to roster' }).click()

  await expect(appAlert(page)).toContainText('First, Fiona already has SIS user ID 90010002')
  expect(await db.rosterEntry.count({ where: { classroomId, sisUserId: '90010002' } })).toBe(1)
  // The rejected input stays in the form rather than being thrown away.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Second, Sam')
})
