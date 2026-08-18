import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Integration tests that talk to a real GitHub organization.
 *
 * Separate from the unit config because these are slow, order-dependent, and
 * create real resources. They run single-threaded and sequentially so they do
 * not race each other through the shared rate budget.
 *
 * Run with: npm run test:github
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(
        new URL('./src/test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.integration.ts'],
    globalSetup: ['./src/test/globalSetup.integration.ts'],
    include: ['src/**/*.integration.test.ts'],
    // Real network calls plus deliberate rate-limit waits.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file at a time, tests in order — these share GitHub state and the
    // shared rate budget, so nothing here may run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
