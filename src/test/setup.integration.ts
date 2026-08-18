import { config } from 'dotenv'

config({ path: '.env', quiet: true })

/**
 * Integration-test environment.
 *
 * The production budget (6 content-creating calls/minute) exists to pace a
 * multi-hour provisioning run for hundreds of students. An integration suite
 * does a deliberate burst of a few dozen calls, so it would spend most of its
 * time waiting — and, worse, a drained bucket would fail the run outright.
 *
 * Raised to 40/minute here, still half of GitHub's documented 80/minute
 * secondary limit, so the suite exercises real API behaviour without ever
 * approaching the ceiling. Set before any module imports, because src/lib/env.ts
 * validates and freezes configuration at import time.
 */
process.env.GITHUB_CONTENT_CALLS_PER_MINUTE = '40'
process.env.GITHUB_CONTENT_CALLS_PER_HOUR = '450'
