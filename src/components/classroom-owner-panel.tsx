import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { signIn } from '@/lib/auth/config'
import { OWNER_PROVIDER_ID } from '@/lib/auth/providers'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { checkOwnerToken } from '@/lib/github/ownerToken'

/**
 * The organization-owner credential for a classroom.
 *
 * This control is what several error messages have always told people to use —
 * "Open classroom settings and use Connect GitHub as organization owner" — and it
 * did not exist. The `github-owner` provider was registered and the token plumbing
 * was complete; the only missing piece was a button, so the advice pointed at
 * nothing and the credential could only ever be established as a side effect of
 * creating the classroom.
 *
 * That mattered once removing an instructor started handing the credential on:
 * when there is no other instructor holding one, it is cleared, and clearing
 * something with no way to restore it would be a worse bug than the one being
 * fixed.
 *
 * Signing in through the second provider is the whole mechanism. It is the same
 * GitHub App and the same identity as the normal sign-in; what differs is that the
 * resulting token is marked as the designated owner credential, so a TA signing in
 * normally is never mistaken for one.
 */
export async function ClassroomOwnerPanel({
  classroomId,
  slug,
  orgLogin,
}: {
  classroomId: string
  slug: string
  orgLogin: string
}) {
  const [status, classroom] = await Promise.all([
    checkOwnerToken(classroomId),
    db.classroom.findUnique({
      where: { id: classroomId },
      select: {
        ownerTokenUser: { select: { name: true, githubLogin: true } },
      },
    }),
  ])

  const holder = classroom?.ownerTokenUser
  const holderLabel = holder?.githubLogin ?? holder?.name ?? null

  // Derived from APP_URL and the provider id, so it cannot drift from the URL Auth.js
  // actually sends. Confirmed against /api/auth/providers, which reports the same.
  const callbackUrl = `${env.APP_URL.replace(/\/$/, '')}/api/auth/callback/${OWNER_PROVIDER_ID}`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization owner</CardTitle>
        <CardDescription>
          A fallback credential for work GitHub will not let the app do on its own —
          creating teams in <span className="font-mono text-xs">{orgLogin}</span>, and
          adding people who are not organization members yet. Individual assignments do
          not need it; group assignments can.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {/*
            * The left side says who holds the credential, the badge says whether it
            * works. They are different questions: creating a classroom assigns the
            * credential to its creator immediately, but no token exists until someone
            * completes the connection below — so "assigned to you" and "not connected"
            * are both true at once, and saying only "Not connected" twice explained
            * neither.
            */}
          <span>
            {holderLabel ? (
              <>
                {status.ok ? 'Connected as ' : 'Assigned to '}
                <span className="font-mono text-xs">{holderLabel}</span>
              </>
            ) : (
              'Nobody is assigned yet.'
            )}
          </span>
          {status.ok ? (
            <Badge tone="success">Connected</Badge>
          ) : holderLabel ? (
            <Badge tone="warning">No token stored</Badge>
          ) : (
            <Badge tone="warning">Not connected</Badge>
          )}
        </div>

        {!status.ok ? <p className="text-muted">{status.reason}</p> : null}

        <form
          action={async () => {
            'use server'
            await signIn(OWNER_PROVIDER_ID, {
              redirectTo: `/classrooms/${slug}/settings`,
            })
          }}
        >
          <Button type="submit" variant={status.ok ? 'outline' : 'accent'}>
            {status.ok
              ? 'Reconnect GitHub as organization owner'
              : 'Connect GitHub as organization owner'}
          </Button>
        </form>

        <p className="text-xs text-muted">
          You must be an <strong>Owner</strong> of {orgLogin} on GitHub for this to grant
          anything. Connecting as a member succeeds and still cannot create teams, which is
          why the check above reports the credential rather than the outcome.
        </p>

        {!status.ok ? (
          /*
           * This button signs in through a second Auth.js provider, so GitHub needs a
           * second callback URL registered — and a missing one surfaces only as GitHub's
           * "redirect_uri is not associated with this application" page, which names
           * nothing you can act on. So the URL is stated here, where someone reads it
           * moments before hitting that error.
           */
          <p className="text-xs text-muted">
            If GitHub reports a <span className="font-mono">redirect_uri</span> problem, add{' '}
            <span className="font-mono break-all">{callbackUrl}</span> to the App&rsquo;s
            callback URLs. It is a second sign-in route, so the one used for normal sign-in
            does not cover it.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
