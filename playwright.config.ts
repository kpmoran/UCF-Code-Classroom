import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests.
 *
 * These drive a real browser against a real dev server, which is the only way to
 * exercise server actions (form submission, redirect, revalidation) and the job
 * worker as a user actually experiences them. Authentication is handled by
 * seeding an Auth.js database session — see e2e/fixtures.ts — because the GitHub
 * OAuth consent screen cannot be automated.
 *
 * Some specs create real repositories in the sandbox organization, so they run
 * serially and clean up after themselves.
 */
const CI = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  /**
   * One retry in CI, none locally.
   *
   * Locally a failure should stay failed — retrying hides the flake you want to
   * see. In CI the suite makes real network calls to GitHub, and an ETIMEDOUT on
   * a shared runner is not a product defect. The specs clean up in hooks rather
   * than trailing statements, so a retry starts from a clean slate.
   */
  retries: CI ? 1 : 0,
  timeout: 120_000,
  /**
   * A GitHub-hosted runner has two cores and compiles routes on demand in dev
   * mode, so the first assertion after navigating to a cold route waits on a
   * webpack build rather than on the application.
   */
  expect: { timeout: CI ? 30_000 : 15_000 },
  // 'github' adds inline annotations on the pull request diff; 'html' is what the
  // workflow uploads as an artifact when something fails.
  reporter: CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/globalSetup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    // Reused if already running, which keeps local iteration fast. Note that a
    // server started outside this config will not pick up the env below — which
    // is exactly why CI always starts its own.
    reuseExistingServer: !CI,
    // Cold `next dev` on a two-core runner spends a while on the first compile.
    timeout: CI ? 240_000 : 120_000,
    env: {
      /**
       * The production budget of 6 content-creating calls/minute exists to pace a
       * multi-hour provisioning run for hundreds of students. A test suite makes
       * a short burst of a few dozen calls, so under that budget jobs would spend
       * most of the run backing off and the suite would be slow and flaky.
       *
       * 40/minute is still half of GitHub's documented 80/minute secondary limit,
       * so the tests exercise real API behaviour without approaching the ceiling.
       */
      GITHUB_CONTENT_CALLS_PER_MINUTE: '40',
      GITHUB_CONTENT_CALLS_PER_HOUR: '450',

      /**
       * Pinned here so the suite does not depend on whatever happens to be in a
       * developer's .env.
       *
       * A faculty test asserts that a configuration-listed admin has no "Withdraw"
       * button, since configuration outranks the database. That passed locally, where
       * .env happens to list this login, and failed in CI, where nothing does — the
       * test was reading ambient state rather than state it had set.
       */
      SITE_ADMIN_LOGINS: 'kpmoran',

      /**
       * Placeholders, for the same reason: the suite must not depend on whatever is in
       * a developer's .env.
       *
       * The sign-in pages render a "Continue with GitHub" button only when both are
       * non-empty, and otherwise show a "not configured" notice. Locally .env supplies
       * real values so the button appeared; CI supplies the GitHub *App* credentials
       * but not the *OAuth* ones, so two tests looked for a button that was never
       * rendered.
       *
       * Safe as placeholders because nothing here completes an OAuth flow — sessions
       * are seeded directly, since the GitHub consent screen cannot be automated — and
       * these values are used for nothing else. The real App credentials, which the
       * suite genuinely calls GitHub with, come from secrets and are untouched.
       */
      AUTH_GITHUB_ID: 'Iv23-e2e-placeholder',
      AUTH_GITHUB_SECRET: 'e2e-placeholder-secret',
    },
  },
})
