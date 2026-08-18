import { db } from '@/lib/db'

/**
 * Liveness and readiness for the deploy gate and the container health check.
 *
 * Actually touches the database, because "the container is running" and "the app
 * can serve a request" are different claims and only the second one matters when
 * deciding whether a deploy succeeded. A container that boots with an unreachable
 * DATABASE_URL answers every page with a 500; this endpoint is what lets the
 * deployment notice that instead of reporting success.
 *
 * Unauthenticated — a load balancer cannot sign in — so it returns nothing beyond
 * ok/not-ok. No version, no hostname, no error text: a health endpoint is the most
 * reliably reachable thing on a host and a bad one is a free reconnaissance
 * channel.
 */

// Never cached or prerendered: a cached health check is worse than none.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const headers = { 'Cache-Control': 'no-store' }

  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers })
  }

  return Response.json({ status: 'ok' }, { status: 200, headers })
}
