/**
 * Screenshots the running app for the promo video, then renders the scene deck.
 *
 *   node promo/capture.mjs <baseUrl> <sessionToken> <classroomSlug> <assignmentId>
 *
 * Two things are worth knowing before re-running it.
 *
 * The scroll is absolute, computed from the element's measured offset. The obvious
 * `scrollIntoViewIfNeeded()` followed by a relative nudge does nothing when the
 * element is already on screen, and the nudge then scrolls the wrong way — which
 * silently produced a scene whose caption promised a table the picture did not show.
 *
 * Anchors are matched on structure (a table, a heading with an exact name) rather
 * than loose text. `getByText('Repositories')` also matches the sentence "rewrites
 * the workflow in 16 existing repositories", and lands somewhere else entirely.
 *
 * Get a session token with:  npx tsx scripts/dev-session.ts <login>
 */
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const [base, token, slug, assignmentId] = process.argv.slice(2)

if (!base || !token || !slug || !assignmentId) {
  console.error('usage: node promo/capture.mjs <baseUrl> <sessionToken> <slug> <assignmentId>')
  process.exit(1)
}

const host = new URL(base).hostname
const browser = await chromium.launch()

/** The app, in dark mode, at 2x — the video crops into these pixels. */
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
await context.addCookies([
  { name: 'authjs.session-token', value: token, domain: host, path: '/' },
])

async function shot(file, path, selector, pad = 70) {
  const page = await context.newPage()
  await page.goto(base + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  if (selector) {
    const top = await page
      .locator(selector)
      .first()
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, top - pad))
    await page.waitForTimeout(400)
  }

  await page.screenshot({ path: resolve(HERE, 'shots', `${file}.png`) })
  console.log(`  ${file}`)
  await page.close()
}

// Signed out, for the front page.
const anon = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const landing = await anon.newPage()
await landing.goto(base, { waitUntil: 'networkidle' })
await landing.waitForTimeout(1200)
await landing.screenshot({ path: resolve(HERE, 'shots', 's1-landing.png') })
console.log('  s1-landing')
await anon.close()

await shot('s2-roster', `/classrooms/${slug}/roster`, 'text=Import roster from Canvas', 90)
await shot('s3-roster-tbl', `/classrooms/${slug}/roster`, 'table thead')
await shot('s4-newassign', `/classrooms/${slug}/assignments/new`, 'text=Starting point', 90)
await shot('s5-repos', `/classrooms/${slug}/assignments/${assignmentId}`, 'table >> nth=-1')
await shot('s7-grades', `/classrooms/${slug}/grades`, 'text=Export to Canvas', 90)

// Render the deck at 2x, so the slow push in the video crops real pixels rather
// than upscaling a 1080p still.
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
})
const deck = `file://${resolve(HERE, 'scene.html')}`
await page.goto(`${deck}?s=0`)
const count = await page.evaluate(() => window.__sceneCount)

for (let i = 0; i < count; i++) {
  await page.goto(`${deck}?s=${i}`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)

  const missing = await page.evaluate(() =>
    [...document.images].filter((im) => !im.complete || im.naturalWidth === 0).map((im) => im.src),
  )
  if (missing.length) console.error(`  scene ${i}: MISSING ${missing.join(', ')}`)

  await page.screenshot({
    path: resolve(HERE, 'scenes', `scene-${String(i).padStart(2, '0')}.png`),
  })
}
console.log(`  ${count} scenes rendered — now run: bash promo/build-video.sh`)

await browser.close()
