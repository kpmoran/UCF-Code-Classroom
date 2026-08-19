import Link from 'next/link'

import { LandingPage } from '@/components/landing/landing-page'
import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/table'
import { getCurrentUser, listMyClassrooms } from '@/lib/auth/dal'
import { ROLE_LABEL } from '@/lib/auth/roles'

export default async function HomePage() {
  const user = await getCurrentUser()

  // Visitors get the marketing page; members get their classrooms. Students never
  // see the former — they arrive on /join/<token> from an instructor's link.
  if (!user) return <LandingPage />

  const memberships = await listMyClassrooms()
  const staffOf = memberships.filter((m) => m.role !== 'STUDENT')

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Classrooms</h1>
            <p className="text-sm text-muted mt-1">
              {memberships.length === 0
                ? 'You are not in any classroom yet.'
                : `${memberships.length} classroom${memberships.length === 1 ? '' : 's'}.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {user.isSiteAdmin ? (
              <ButtonLink href="/admin/faculty" variant="outline">
                Faculty access
              </ButtonLink>
            ) : null}
            {user.isFaculty ? (
              <ButtonLink href="/classrooms/new" variant="accent">New classroom</ButtonLink>
            ) : null}
          </div>
        </div>

        {memberships.length === 0 ? (
          <Card>
            {/*
             * Two different situations that look identical from here, so they get
             * different text. A student with no classroom needs their instructor's
             * link; an instructor with no classroom needs to make one. Offering
             * "create a classroom" to someone who is not allowed to would send them
             * to a 403.
             */}
            {user.isFaculty ? (
              <EmptyState
                title="No classrooms yet"
                description="Create a classroom to get started."
                action={
                  <ButtonLink href="/classrooms/new" variant="accent">
                    Create a classroom
                  </ButtonLink>
                }
              />
            ) : (
              <>
                {/*
                 * Written for a student, because that is who is overwhelmingly here:
                 * signing in before the instructor has shared the link, or before the
                 * roster is imported, is a normal thing to do and leaves exactly this
                 * screen. Telling them about faculty invitations — which the previous
                 * wording did — answers a question they did not ask and implies they
                 * are missing a step they are not.
                 *
                 * The faculty note stays, but demoted, because someone who teaches here
                 * knows they teach here and will recognise it.
                 */}
                <EmptyState
                  title="No classrooms yet"
                  description="Open the invite link your instructor sent you and pick your name from the roster. There is nothing to set up first — if you have not been sent a link yet, there is nothing to do but wait for it."
                />
                <p className="px-6 pb-6 -mt-2 text-center text-xs text-muted">
                  Teaching staff join by invitation from a site administrator.
                </p>
              </>
            )}
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {memberships.map(({ role, classroom }) => (
              <Card key={classroom.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">
                        <Link
                          href={`/classrooms/${classroom.slug}`}
                          className="hover:underline"
                        >
                          {classroom.name}
                        </Link>
                      </CardTitle>
                      <CardDescription className="truncate">
                        {[classroom.courseCode, classroom.term].filter(Boolean).join(' · ') ||
                          'No course code'}
                      </CardDescription>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge tone={role === 'STUDENT' ? 'neutral' : 'info'}>
                        {ROLE_LABEL[role]}
                      </Badge>
                      {classroom.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="text-sm text-muted flex gap-4 flex-wrap">
                  <span>{classroom._count.assignments} assignments</span>
                  {role !== 'STUDENT' ? (
                    <span>{classroom._count.rosterEntries} on roster</span>
                  ) : null}
                  <span className="font-mono text-xs truncate">
                    {classroom.githubOrgLogin}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {staffOf.length > 0 ? (
          <p className="text-xs text-muted">
            You manage {staffOf.length} classroom{staffOf.length === 1 ? '' : 's'}.
          </p>
        ) : null}
      </main>
    </>
  )
}
