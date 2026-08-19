import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/dal'
import { signIn } from '@/lib/auth/config'
import { env } from '@/lib/env'

/**
 * The administrator door.
 *
 * Framing and destination, not a separate authentication mechanism — there is only
 * one, GitHub OAuth, so this is the same button pointed somewhere else. It is not a
 * security boundary and does not pretend to be: anyone may open this URL and sign in,
 * and they will land on a dashboard with nothing on it unless SITE_ADMIN_LOGINS names
 * them. The authorization is that list, checked on every request.
 *
 * What it buys is that the front page no longer has to carry a generic "Sign in"
 * button addressed to nobody, and that an administrator has a bookmarkable URL which
 * says what it is for and drops them where they work.
 */
export default async function AdminSignInPage(props: PageProps<'/admin/signin'>) {
  const params = await props.searchParams
  const user = await getCurrentUser()

  // Already signed in: send them where they were going rather than showing a
  // sign-in page to someone who is signed in.
  if (user) redirect(user.isSiteAdmin ? '/admin/faculty' : '/')

  const configured = Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET)
  const errorCode = typeof params.error === 'string' ? params.error : null

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-6 gap-4">
      <div className="w-full max-w-md flex justify-end">
        <ThemeToggle />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Administrator sign-in</CardTitle>
          <CardDescription>
            For site administrators. Teaching staff should use the invitation link they
            were sent; students should use the link from their instructor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorCode ? (
            <p
              role="alert"
              className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2"
            >
              Sign-in failed ({errorCode}). Try again, or check the server logs.
            </p>
          ) : null}

          {configured ? (
            <form
              action={async () => {
                'use server'
                await signIn('github', { redirectTo: '/admin/faculty' })
              }}
            >
              <Button type="submit" size="lg" className="w-full">
                Continue with GitHub
              </Button>
            </form>
          ) : (
            <div className="text-sm rounded-md bg-warning-subtle text-warning px-3 py-2">
              <p className="font-medium">GitHub sign-in is not configured.</p>
              <p className="mt-1">
                Set <code className="font-mono">AUTH_GITHUB_ID</code> and{' '}
                <code className="font-mono">AUTH_GITHUB_SECRET</code> on the server, then
                recreate the container with{' '}
                <code className="font-mono">docker compose up -d app</code>.
              </p>
            </div>
          )}

          <p className="text-xs text-muted">
            Signing in here does not grant anything on its own. Administrators are named in
            the server&rsquo;s configuration.
          </p>

          <p className="text-xs text-muted">
            <Link href="/" className="underline">
              Back to the homepage
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
