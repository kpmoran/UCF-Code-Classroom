import { applySession, db, expect, seedSession, test } from './fixtures'

/**
 * The public front page and the two ways in.
 *
 * The behaviour worth protecting is negative: the homepage must not read as a login
 * wall, and it must not offer a generic sign-in — while /signin itself has to keep
 * working, because the proxy sends students there when they open an instructor's
 * invite link. Delete it and registration breaks, which is precisely the sort of thing
 * that is not noticed until week one.
 */

test.afterAll(async () => {
  await db.$disconnect()
})

test('a visitor gets the landing page, not a sign-in prompt', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Coursework on real GitHub/)
  await expect(page.getByText(/turns a Canvas roster into per-student/)).toBeVisible()

  // The old page was a bare "Sign in" button addressed to nobody. It must not return.
  await expect(page.getByRole('link', { name: /^Sign in$/ })).toHaveCount(0)
})

test('the landing page explains both doors without offering self-serve accounts', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Faculty' })).toBeVisible()
  await expect(page.getByText(/Accounts are not self-serve/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Administrator sign-in' })).toBeVisible()
})

test('a signed-in member sees their classrooms rather than marketing', async ({
  page,
  context,
}) => {
  const user = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, user)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Classrooms' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(/Coursework on real/)
})

test('the administrator door signs in and lands on faculty access', async ({ page }) => {
  await page.goto('/admin/signin')
  await expect(page.getByRole('heading', { name: 'Administrator sign-in' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue with GitHub/ })).toBeVisible()
  // It says plainly that it is framing, not a permission check.
  await expect(page.getByText(/does not grant anything on its own/)).toBeVisible()
})

test('an already signed-in admin is sent onward rather than shown a sign-in page', async ({
  page,
  context,
}) => {
  const admin = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, admin)
  await page.goto('/admin/signin')
  await expect(page).toHaveURL(/\/admin\/faculty$/)
})

test('/signin still works, because invite links depend on it', async ({ page }) => {
  // The proxy bounces signed-out visitors here with `next` set. If this route ever
  // disappears, every student invite link dead-ends.
  await page.goto('/classrooms/anything/roster')
  await expect(page).toHaveURL(/\/signin\?next=/)
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue with GitHub/ })).toBeVisible()
})

test('the animation plays even when reduced motion is requested', async ({ browser }) => {
  // A deliberate product decision, pinned here so it cannot be reverted by accident —
  // and so anyone reading the suite can see it was chosen rather than overlooked.
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto('/')

  const animating = await page
    .locator('.uccc-flow')
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).animationName !== 'none').length)
  expect(animating).toBeGreaterThan(0)

  await context.close()
})

test('content is never left invisible, under either motion preference', async ({ browser }) => {
  // Independent of the decision above and non-negotiable: uccc-rise starts at opacity 0,
  // so any future change that disables the animation without restoring opacity would
  // leave the page blank. That is a worse failure than either motion setting, and it is
  // the one that would be easy to ship without noticing.
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    const context = await browser.newContext({ reducedMotion })
    const page = await context.newPage()
    await page.goto('/')
    await page.waitForTimeout(900) // let the entrance animation finish

    const invisible = await page
      .locator('.uccc-rise')
      .evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity !== '1').length)
    expect(invisible, `with reducedMotion=${reducedMotion}`).toBe(0)

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await context.close()
  }
})

test('the diagram carries a text alternative and is repeated in prose', async ({ page }) => {
  await page.goto('/')
  // To a screen reader a pile of SVG paths is noise, so it is one labelled image —
  // and the same four stages are written out beneath it.
  const diagram = page.getByRole('img', { name: /Four stages/ })
  await expect(diagram).toBeVisible()
  await expect(page.getByText(/Import your Canvas roster and share one invite link/)).toBeVisible()
  await expect(page.getByText(/Autograded scores collect/)).toBeVisible()
})

test('the landing page renders in both themes', async ({ browser }) => {
  for (const [scheme, expected] of [
    ['dark', 'rgb(13, 15, 18)'],
    ['light', 'rgb(255, 255, 255)'],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    await page.goto('/')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(expected)
    await expect(page.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible()
    await context.close()
  }
})
