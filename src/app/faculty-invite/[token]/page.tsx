import Link from 'next/link'

import { AcceptFacultyInvite } from '@/components/accept-faculty-invite'
import { SiteHeader } from '@/components/site-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireUser } from '@/lib/auth/dal'
import { facultyInviteIsUsable } from '@/lib/faculty/actions'

/**
 * Landing page for a faculty invitation.
 *
 * Read-only: it checks whether the invitation is usable and shows a button. It
 * deliberately does not redeem, because this is a GET — a mail client, Slack unfurl or
 * security proxy that follows the link would otherwise consume a single-use invitation
 * before the recipient clicked anything. (Mutating during a render is also not allowed
 * in Next.js, which is how the first version of this announced the problem.)
 *
 * Sign-in comes first, handled by the proxy bouncing to /signin with `next` set, so
 * they arrive back here afterwards.
 */
export default async function FacultyInvitePage(
  props: PageProps<'/faculty-invite/[token]'>,
) {
  const { token } = await props.params
  const user = await requireUser()
  const usable = await facultyInviteIsUsable(token)

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-lg px-6 py-16">
        <Card>
          <CardHeader>
            <CardTitle>
              {usable ? 'You have been invited to teach here' : 'This invitation cannot be used'}
            </CardTitle>
            <CardDescription>
              {usable ? (
                <>
                  Accepting lets{' '}
                  <span className="font-mono">
                    {user.githubLogin ? `@${user.githubLogin}` : (user.name ?? 'this account')}
                  </span>{' '}
                  create classrooms. A classroom is backed by a GitHub organization you own —
                  rosters, assignments and grades all live inside it.
                </>
              ) : (
                'It may have expired, been used already, or been withdrawn. Ask whoever sent it for a fresh link.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usable ? (
              <AcceptFacultyInvite token={token} />
            ) : (
              <p className="text-sm text-muted">
                You are signed in
                {user.githubLogin ? ` as @${user.githubLogin}` : ''}, so if you already belong
                to a classroom you can reach it from{' '}
                <Link href="/" className="underline">
                  your dashboard
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  )
}
