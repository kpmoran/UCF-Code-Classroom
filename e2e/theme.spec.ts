import { applySession, db, expect, seedSession, test } from './fixtures'

/**
 * The colour theme control.
 *
 * The assertions read computed styles rather than looking at the attribute alone,
 * because the attribute being set is not the same claim as the page actually changing
 * colour — and the interesting failure is precisely that one of them happens without
 * the other.
 *
 * Both directions are covered on purpose. Forcing dark on a light machine works even
 * if the override is broken, because the media query is not competing; only forcing
 * light on a *dark* machine proves the override wins. A test suite that checked one
 * direction would pass on a bug visible to half the readers.
 */

test.afterAll(async () => {
  await db.$disconnect()
})

const bodyBackground = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

const themeState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }))

const DARK_BG = 'rgb(13, 15, 18)'
const LIGHT_BG = 'rgb(255, 255, 255)'

test('the control is a labelled radio group with three options', async ({ page }) => {
  await page.goto('/signin')
  const group = page.getByRole('radiogroup', { name: 'Colour theme' })
  await expect(group).toBeVisible()
  await expect(group.getByRole('radio')).toHaveCount(3)
  // Available before signing in: someone who cannot read the page has no reason to
  // authenticate first.
  await expect(group.getByRole('radio', { name: /Follow my system setting/ })).toBeVisible()
})

test('Auto follows the system in both directions', async ({ browser }) => {
  for (const [scheme, expected] of [
    ['dark', DARK_BG],
    ['light', LIGHT_BG],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    await page.goto('/signin')
    expect(await bodyBackground(page)).toBe(expected)
    // No attribute at all for Auto: a data-theme of "system" would be a third state
    // the stylesheet does not know about.
    expect((await themeState(page)).attr).toBeNull()
    await context.close()
  }
})

test('forcing light beats a dark system setting', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/signin')
  expect(await bodyBackground(page)).toBe(DARK_BG)

  await page.getByRole('radio', { name: /Always use the light theme/ }).click()

  expect(await bodyBackground(page)).toBe(LIGHT_BG)
  const state = await themeState(page)
  expect(state.attr).toBe('light')
  // Native controls must agree with the page, or a forced-light page gets dark
  // checkboxes and date pickers.
  expect(state.colorScheme).toBe('light')
  await context.close()
})

test('forcing dark beats a light system setting', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto('/signin')
  expect(await bodyBackground(page)).toBe(LIGHT_BG)

  await page.getByRole('radio', { name: /Always use the dark theme/ }).click()

  expect(await bodyBackground(page)).toBe(DARK_BG)
  const state = await themeState(page)
  expect(state.attr).toBe('dark')
  expect(state.colorScheme).toBe('dark')
  await context.close()
})

test('the choice survives reload and navigation, and can be given back', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/signin')
  await page.getByRole('radio', { name: /Always use the light theme/ }).click()
  expect(await bodyBackground(page)).toBe(LIGHT_BG)

  await page.reload()
  expect(await bodyBackground(page)).toBe(LIGHT_BG)

  // A different route, because the inline head script has to run on every document,
  // not only the first one.
  await page.goto('/')
  expect(await bodyBackground(page)).toBe(LIGHT_BG)

  await page.getByRole('radio', { name: /Follow my system setting/ }).click()
  expect(await bodyBackground(page)).toBe(DARK_BG)
  expect((await themeState(page)).attr).toBeNull()

  await page.reload()
  expect(await bodyBackground(page)).toBe(DARK_BG)
  await context.close()
})

test('the selected option is the one reported as checked', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/signin')

  const auto = page.getByRole('radio', { name: /Follow my system setting/ })
  const dark = page.getByRole('radio', { name: /Always use the dark theme/ })
  await expect(auto).toHaveAttribute('aria-checked', 'true')
  await expect(dark).toHaveAttribute('aria-checked', 'false')

  await dark.click()
  await expect(dark).toHaveAttribute('aria-checked', 'true')
  await expect(auto).toHaveAttribute('aria-checked', 'false')
  await context.close()
})

test('a signed-in reader keeps their choice across pages', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' })
  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  await applySession(context, instructor)
  const page = await context.newPage()

  await page.goto('/')
  await page.getByRole('radio', { name: /Always use the dark theme/ }).click()
  expect(await bodyBackground(page)).toBe(DARK_BG)

  await page.goto('/admin/faculty')
  expect(await bodyBackground(page)).toBe(DARK_BG)
  await context.close()
})
