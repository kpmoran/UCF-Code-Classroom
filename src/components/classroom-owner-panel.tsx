import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { signIn } from '@/lib/auth/config'
import { OWNER_PROVIDER_ID } from '@/lib/auth/providers'
import { db } from '@/lib/db'
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
          <span>
            {status.ok && holderLabel ? (
              <>
                Connected as <span className="font-mono text-xs">{holderLabel}</span>
              </>
            ) : (
              'Not connected'
            )}
          </span>
          {status.ok ? (
            <Badge tone="success">Connected</Badge>
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
      </CardContent>
    </Card>
  )
}
