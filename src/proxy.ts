import { NextResponse, type NextRequest } from 'next/server'

/**
 * Proxy — what earlier Next.js versions called middleware.
 *
 * This performs an *optimistic* redirect only: it checks for the presence of a
 * session cookie so signed-out visitors are bounced to /signin without paying
 * for a render. It deliberately does not read the database and is not the
 * authorization boundary — a forged or stale cookie gets past it. Real checks
 * live in src/lib/auth/dal.ts, which every protected page and server action
 * calls. See the Next.js authentication guide, "Optimistic checks with Proxy".
 */

const PUBLIC_PREFIXES = [
  '/signin',
  '/api/auth',
  // GitHub posts here with an HMAC signature rather than a session cookie.
  '/api/webhooks',
  // The deploy gate and the container health check cannot sign in. Left behind the
  // cookie wall it answers 307 to /signin, which reads as a healthy 3xx to some
  // probes and as a failure to others — either way it stops being a health check.
  '/api/health',
  '/join', // Invite links: the landing page itself explains sign-in.
  // The administrator door. Only ever useful to someone signed out, so leaving it
  // behind the cookie wall bounced exactly the people it exists for to /signin —
  // making it a link to nowhere. Note this is the full path, not '/admin': the rest
  // of /admin stays protected.
  '/admin/signin',
]

// Auth.js names the session cookie `__Secure-` prefixed over HTTPS.
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname === '/' || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name))
  if (hasSession) return NextResponse.next()

  const signInUrl = new URL('/signin', request.url)
  // Preserve where they were going so sign-in can return them there.
  signInUrl.searchParams.set('next', pathname + request.nextUrl.search)
  return NextResponse.redirect(signInUrl)
}

export const config = {
  // Skip Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
