import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { test as base, type BrowserContext, type Page } from '@playwright/test'

/**
 * Test fixtures.
 *
 * Signing in is done by inserting an Auth.js session row and setting the cookie
 * directly. The GitHub OAuth consent screen cannot be automated, and mocking the
 * provider would mean the tests no longer exercise the real auth path — a seeded
 * database session is the same code path a signed-in user takes, minus the
 * redirect dance.
 */

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

export type SeededUser = {
  id: string
  login: string
  sessionToken: string
}

export async function seedSession(
  login: string,
  opts: { isSiteAdmin?: boolean } = {},
): Promise<SeededUser> {
  const user = await db.user.upsert({
    where: { githubLogin: login },
    update: { isSiteAdmin: opts.isSiteAdmin ?? false },
    create: {
      githubLogin: login,
      name: login,
      email: `${login}@e2e.invalid`,
      githubId: String(910_000_000 + (Math.abs(hashCode(login)) % 1_000_000)),
      isSiteAdmin: opts.isSiteAdmin ?? false,
    },
  })

  const sessionToken = randomBytes(32).toString('hex')
  await db.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })

  return { id: user.id, login, sessionToken }
}

export async function applySession(context: BrowserContext, user: SeededUser) {
  await context.addCookies([
    {
      name: 'authjs.session-token',
      value: user.sessionToken,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/**
 * The application's own alert region.
 *
 * Next.js injects a `<div role="alert" id="__next-route-announcer__">` into every
 * page for screen-reader route announcements, so a bare
 * `getByRole('alert')` always matches two elements and fails Playwright's strict
 * mode. Use this instead of reaching for the role directly.
 */
export function appAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)')
}

/**
 * Reveal the staff assignment page's Settings tab.
 *
 * The deadline, autograding, feedback and project-board panels moved behind a tab,
 * so a test that lands on the page and looks for them finds them in the DOM but
 * hidden — `toBeVisible()` fails with "element(s) not found" rather than anything
 * that hints at a tab. Call this after navigating, before asserting on any setting.
 */
export async function openSettingsTab(page: Page) {
  await page.getByRole('tab', { name: 'Settings' }).click()
}

export const test = base
export { expect } from '@playwright/test'
