import { redirect } from 'next/navigation'

import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/dal'
import { signIn } from '@/lib/auth/config'
import { env } from '@/lib/env'

const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    'That GitHub account is already linked to a different UCF Code Classroom user.',
  AccessDenied: 'You cancelled the GitHub authorization, or access was denied.',
  Configuration:
    'GitHub sign-in is not configured on this server. See "GitHub App setup" in the README.',
}

export default async function SignInPage(props: PageProps<'/signin'>) {
  const params = await props.searchParams
  const user = await getCurrentUser()

  const next = typeof params.next === 'string' ? params.next : '/'
  if (user) redirect(next)

  const errorCode = typeof params.error === 'string' ? params.error : null
  const configured = Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET)

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-6 gap-4">
      {/*
       * The theme control belongs here as well as in the site header, which this page
       * does not render. Someone who cannot comfortably read the page needs to fix
       * that *before* signing in, not after — putting an accessibility control behind
       * authentication defeats it.
       */}
      <div className="w-full max-w-md flex justify-end">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to continue</CardTitle>
          <CardDescription>
            {/*
             * Reached by following a link — a classroom invite, a faculty invitation, or
             * a bookmarked page — because the proxy sends signed-out visitors here with
             * `next` set. Worded for that, rather than as a general front door, which is
             * now the landing page.
             */}
            Use the GitHub account you will submit coursework with. It gets linked to your
            entry on the course roster, so use the same one all semester.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorCode ? (
            <p
              role="alert"
              className="text-sm rounded-md border border-transparent bg-danger-subtle text-danger px-3 py-2"
            >
              {ERROR_MESSAGES[errorCode] ?? `Sign-in failed (${errorCode}).`}
            </p>
          ) : null}

          {configured ? (
            <form
              action={async () => {
                'use server'
                await signIn('github', { redirectTo: next })
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
                <code className="font-mono">AUTH_GITHUB_SECRET</code> in{' '}
                <code className="font-mono">.env</code>, then restart. See “GitHub App
                setup” in the README.
              </p>
            </div>
          )}

          <p className="text-xs text-muted">
            Signing in requests read-only access to your GitHub profile and email. Nothing
            is written to your account.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
