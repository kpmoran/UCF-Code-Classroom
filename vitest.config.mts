import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Native replacement for the vite-tsconfig-paths plugin: resolves the
    // `@/*` alias from tsconfig.json.
    tsconfigPaths: true,
    alias: {
      // See src/test/stubs/server-only.ts for why.
      'server-only': fileURLToPath(
        new URL('./src/test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    // src/lib/env.ts validates at import time, so .env must load first.
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [
      'e2e/**',
      'node_modules/**',
      // Integration tests hit real GitHub and create real repositories. They
      // must never run as part of `npm test` — see vitest.integration.config.mts
      // and `npm run test:github`.
      'src/**/*.integration.test.ts',
    ],
  },
})
