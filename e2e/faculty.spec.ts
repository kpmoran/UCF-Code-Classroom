import { appAlert, applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Who may create classrooms.
 *
 * The gap this closes: signing in with GitHub proves only that someone has a GitHub
 * account, and every student has one — so before this, any student who found the URL
 * could create a classroom and become its instructor.
 *
 * The tests that matter here are the negative ones. A hidden button is not a
 * permission check, so the page and the action are both exercised.
 */

const ADMIN = 'kpmoran' // listed in SITE_ADMIN_LOGINS
const OUTSIDER = 'e2e-faculty-outsider'

async function setFaculty(userId: string, isFaculty: boolean) {
  await db.user.update({ where: { id: userId }, data: { isFaculty } })
}

test.beforeEach(async () => {
  await db.facultyInvite.deleteMany({})
  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
})

test.afterAll(async () => {
  await db.facultyInvite.deleteMany({})
  await db.$disconnect()
})

test('a signed-in outsider cannot reach classroom creation or faculty admin', async ({
  page,
  context,
}) => {
  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)

  expect((await page.goto('/classrooms/new'))?.status()).toBe(403)
  expect((await page.goto('/admin/faculty'))?.status()).toBe(403)
})

test('the dashboard offers an outsider no way to create, and says what to do', async ({
  page,
  context,
}) => {
  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)
  await page.goto('/')

  await expect(page.getByRole('link', { name: 'New classroom' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Create a classroom' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Faculty access' })).toHaveCount(0)

  // Written for a student, because signing in before the instructor shares the link is
  // a normal thing to do and lands exactly here. It must not imply they have missed a
  // step, and it must not send them chasing a faculty invitation they do not want.
  await expect(page.getByText(/invite link your instructor sent you/i)).toBeVisible()
  await expect(page.getByText(/nothing to set up first/i)).toBeVisible()
  // The faculty route is mentioned, but demoted rather than made the headline.
  await expect(page.getByText(/Teaching staff join by invitation/i)).toBeVisible()
})

test('a student who signs in before enrolment can still claim their place later', async ({
  page,
  context,
}) => {
  // The order people actually do this in: sign in first, get added to a roster
  // afterwards. Nothing about the early sign-in may block the later claim.
  const early = await seedSession('e2e-early-student')
  await setFaculty(early.id, false)
  await applySession(context, early)

  await page.goto('/')
  await expect(page.getByText(/No classrooms yet/)).toBeVisible()

  // Nothing was created on their behalf by signing in.
  expect(
    await db.classroomMember.count({ where: { userId: early.id } }),
  ).toBe(0)
  expect(
    await db.rosterEntry.count({ where: { claimedByUserId: early.id } }),
  ).toBe(0)
})

test('the create action refuses an outsider even when the page is bypassed', async ({
  page,
  context,
}) => {
  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)

  const before = await db.classroom.count()

  // Posting the server action directly is the bypass a hidden button does not stop.
  // Next.js rejects an unauthenticated/forbidden action with a non-2xx; either way the
  // only thing that matters is that no classroom appears.
  await page.goto('/')
  const status = await page.evaluate(async () => {
    const res = await fetch('/classrooms/new', { method: 'POST', body: new FormData() })
    return res.status
  })
  expect(status).not.toBe(200)
  expect(await db.classroom.count()).toBe(before)
})

test('an admin invites a colleague, who redeems it and can then create', async ({
  page,
  context,
  browser,
}) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  await applySession(context, admin)
  await page.goto('/admin/faculty')

  await page.getByLabel('Who is it for?').fill('Dr. Rivera, COP 3502')
  await page.getByRole('button', { name: 'Create invitation' }).click()

  const field = page.locator('input[readonly]')
  await expect(field).toBeVisible()
  const url = await field.inputValue()
  expect(url).toContain('/faculty-invite/')

  // Redeem as somebody else entirely.
  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  const theirContext = await browser.newContext()
  await applySession(theirContext, outsider)
  const theirPage = await theirContext.newPage()

  await theirPage.goto(new URL(url).pathname)
  await expect(theirPage.getByText(/invited to teach here/i)).toBeVisible()

  // Merely landing here must not grant anything — otherwise a mail or Slack link
  // scanner following the URL would consume the invitation.
  expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).isFaculty).toBe(false)
  expect(await db.facultyInviteRedemption.count()).toBe(0)

  await theirPage.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(theirPage.getByRole('status')).toContainText(/can now create classrooms/i)

  expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).isFaculty).toBe(true)

  // And the gate now lets them through.
  expect((await theirPage.goto('/classrooms/new'))?.status()).toBe(200)
  await theirContext.close()
})

test('redeeming twice does not consume a second use', async ({ page, context }) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  const invite = await db.facultyInvite.create({
    data: { token: 'e2e-twice-token-aaaaaaaa', maxUses: 2, createdByUserId: admin.id },
    select: { id: true, token: true },
  })

  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)

  await page.goto(`/faculty-invite/${invite.token}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('status')).toBeVisible()

  // Accept a second time: reports success without spending another use.
  await page.goto(`/faculty-invite/${invite.token}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('status')).toContainText(/already had access/i)

  expect(await db.facultyInviteRedemption.count({ where: { inviteId: invite.id } })).toBe(1)
})

test('a revoked invitation is refused without saying why', async ({ page, context }) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  const invite = await db.facultyInvite.create({
    data: {
      token: 'e2e-revoked-token-bbbbbbb',
      createdByUserId: admin.id,
      revokedAt: new Date(),
    },
    select: { token: true },
  })

  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)
  await page.goto(`/faculty-invite/${invite.token}`)

  await expect(page.getByText(/cannot be used/i)).toBeVisible()
  // One message for every rejection: distinguishing "revoked" from "no such invite"
  // would confirm to someone guessing tokens that a given one exists.
  await expect(page.getByText(/expired, been used already, or been withdrawn/i)).toBeVisible()
  expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).isFaculty).toBe(false)
})

test('an exhausted invitation is refused with the same message', async ({ page, context }) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  const other = await seedSession('e2e-faculty-first-taker')
  const invite = await db.facultyInvite.create({
    data: {
      token: 'e2e-used-up-token-ccccccc',
      maxUses: 1,
      createdByUserId: admin.id,
      redemptions: { create: { userId: other.id } },
    },
    select: { token: true },
  })

  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  await applySession(context, outsider)
  await page.goto(`/faculty-invite/${invite.token}`)

  await expect(page.getByText(/expired, been used already, or been withdrawn/i)).toBeVisible()
  expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).isFaculty).toBe(false)
})

test('an admin can withdraw access but not their own', async ({ page, context }) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  const colleague = await seedSession('e2e-faculty-colleague')
  await setFaculty(colleague.id, true)

  await applySession(context, admin)
  await page.goto('/admin/faculty')

  const row = page.locator('tr', { hasText: 'e2e-faculty-colleague' })
  await row.getByRole('button', { name: 'Withdraw' }).click()
  await expect(row).toHaveCount(0)

  expect((await db.user.findUniqueOrThrow({ where: { id: colleague.id } })).isFaculty).toBe(false)

  // Their own row is config-derived, so it offers no Withdraw button at all — the
  // configuration is the source of truth and a database edit could not override it.
  const ownRow = page.locator('tr', { hasText: ADMIN })
  await expect(ownRow.getByText(/set in configuration/)).toBeVisible()
})

test('a revoked invitation can no longer be redeemed after revoking it in the UI', async ({
  page,
  context,
  browser,
}) => {
  const admin = await seedSession(ADMIN, { isSiteAdmin: true })
  const invite = await db.facultyInvite.create({
    data: { token: 'e2e-revoke-in-ui-ddddddd', createdByUserId: admin.id, note: 'Revoke me' },
    select: { token: true },
  })

  await applySession(context, admin)
  await page.goto('/admin/faculty')
  const row = page.locator('tr', { hasText: 'Revoke me' })
  await row.getByRole('button', { name: 'Revoke' }).click()
  await expect(row.getByText('Revoked')).toBeVisible()

  const outsider = await seedSession(OUTSIDER)
  await setFaculty(outsider.id, false)
  const theirContext = await browser.newContext()
  await applySession(theirContext, outsider)
  const theirPage = await theirContext.newPage()
  await theirPage.goto(`/faculty-invite/${invite.token}`)
  await expect(theirPage.getByText(/cannot be used/i)).toBeVisible()
  await theirContext.close()

  // No stray alert on the admin page from the revoke.
  await expect(appAlert(page)).toHaveCount(0)
})

test('a faculty member is not offered organizations they do not belong to', async ({
  page,
  context,
}) => {
  /*
   * The multi-tenancy gate. listAppInstallations is App-wide, so before this the picker
   * offered every colleague's organization — and the ownership check downstream only
   * warns, so a classroom could be created in someone else's org and generate
   * repositories there with an installation token holding Administration: write.
   *
   * This colleague is faculty but a member of nothing, so the page must offer nothing
   * and must say why rather than looking broken.
   */
  const colleague = await seedSession('e2e-other-faculty')
  await db.user.update({ where: { id: colleague.id }, data: { isFaculty: true } })
  await applySession(context, colleague)

  await page.goto('/classrooms/new')
  await expect(page.getByRole('heading', { name: 'No GitHub organization available' })).toBeVisible()
  await expect(page.getByText(/not installed on any organization you belong to/i)).toBeVisible()

  // The sandbox org has the app installed, so this must be acknowledged rather than
  // presented as "nothing is installed", which would read as a broken page.
  await expect(page.getByText(/you are not a member/i)).toBeVisible()

  // And the way out is a link to the App, derived from the API rather than hardcoded.
  await expect(page.getByRole('link', { name: /Install the app on an organization/ })).toBeVisible()
})

test('the create action refuses an organization the caller is not a member of', async ({
  page,
  context,
}) => {
  // A filtered dropdown is not a permission check, so this posts directly.
  //
  // Honest about its limits: Next.js rejects an unrecognised server-action request
  // before the action body runs, so what this proves is the outcome — no classroom
  // appears — rather than that the membership gate specifically refused it. The gate's
  // own decision is unit tested in lib/github/orgMembership.test.ts, and the picker
  // side of it is covered by the test above.
  const colleague = await seedSession('e2e-other-faculty')
  await db.user.update({ where: { id: colleague.id }, data: { isFaculty: true } })
  await applySession(context, colleague)

  const before = await db.classroom.count()

  await page.goto('/')
  const status = await page.evaluate(async () => {
    const body = new FormData()
    body.set('name', 'Smash And Grab')
    body.set('courseCode', 'EVIL1')
    body.set('term', 'Fall 2026')
    // The real sandbox installation, which this account has nothing to do with.
    body.set('installationId', '154461207')
    const res = await fetch('/classrooms/new', { method: 'POST', body })
    return res.status
  })

  expect(status).not.toBe(200)
  expect(await db.classroom.count()).toBe(before)
})
