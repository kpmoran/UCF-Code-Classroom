import { redirect } from 'next/navigation'

import { JoinClassroomForm } from '@/components/join-classroom-form'
import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { listClaimableEntries, resolveInviteToken, suggestEntryForUser } from '@/lib/roster/join'

/**
 * Student registration via invite link.
 *
 * Public route: the page must render for a signed-out visitor so they know what
 * they are signing in to. The roster list is only shown after sign-in, since it
 * contains classmates' names.
 */
export default async function JoinPage(props: PageProps<'/join/[token]'>) {
  const { token } = await props.params
  const resolution = await resolveInviteToken(token)

  if (!resolution.ok) {
    return (
      <>
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>This link can’t be used</CardTitle>
              <CardDescription>{resolution.reason}</CardDescription>
            </CardHeader>
            <CardContent>
              <ButtonLink href="/" variant="outline">
                Go to UCF-Code-Connect
              </ButtonLink>
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  const classroom = resolution.classroom
  const user = await getCurrentUser()

  if (!user) {
    return (
      <>
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Join {classroom.name}</CardTitle>
              <CardDescription>
                {[classroom.courseCode, classroom.term].filter(Boolean).join(' · ')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted">
                Sign in with the GitHub account you will use to submit coursework. You will
                then pick your name from the class roster so your instructor can match your
                submissions to you.
              </p>
              <ButtonLink
                href={`/signin?next=${encodeURIComponent(`/join/${token}`)}`}
                variant="accent"
                size="lg"
                className="w-full"
              >
                Sign in with GitHub to continue
              </ButtonLink>
              <p className="text-xs text-muted">
                Only your GitHub username, name and email are read. Nothing is written to
                your account.
              </p>
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  // Already registered in this classroom? Send them straight there.
  const existingClaim = await db.rosterEntry.findFirst({
    where: { classroomId: classroom.id, claimedByUserId: user.id, removedAt: null },
    select: { id: true },
  })
  if (existingClaim) redirect(`/classrooms/${classroom.slug}`)

  const [entries, suggestedId] = await Promise.all([
    listClaimableEntries(classroom.id, user.id),
    suggestEntryForUser(classroom.id, user.email),
  ])

  const available = entries.filter((e) => !e.claimed)

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-2xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Join {classroom.name}</CardTitle>
            <CardDescription>
              {[classroom.courseCode, classroom.term].filter(Boolean).join(' · ')} · signed in
              as <span className="font-mono">@{user.githubLogin}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <p className="text-sm text-muted">
                Your instructor has not imported the class roster yet. Check back shortly, or
                let them know you are waiting.
              </p>
            ) : available.length === 0 ? (
              <p className="text-sm text-muted">
                Every name on the roster has already been claimed. If one of them is you,
                ask your instructor to unlink it so you can claim it.
              </p>
            ) : (
              <JoinClassroomForm
                token={token}
                entries={available}
                suggestedId={suggestedId}
                totalClaimed={entries.length - available.length}
              />
            )}
          </CardContent>
        </Card>
      </main>
    </>
  )
}
