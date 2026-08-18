import { config } from 'dotenv'

// `src/lib/env.ts` validates at import time, so the environment has to be
// populated before any module under test is loaded.
config({ path: '.env', quiet: true })

// Note: `server-only` is neutralized via a resolve alias in vitest.config.mts,
// not here — see src/test/stubs/server-only.ts.
