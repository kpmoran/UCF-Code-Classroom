import Link from 'next/link'

import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/table'
import { getCurrentUser, listMyClassrooms } from '@/lib/auth/dal'
import { ROLE_LABEL } from '@/lib/auth/roles'

export default async function HomePage() {
  const user = await getCurrentUser()

  if (!user) {
    return (
      <>
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-xl text-center space-y-4">
            <h1 className="text-3xl font-semibold">UCF-Code-Connect</h1>
            <p className="text-muted">
              Course assignment management backed by GitHub. Sign in to see your classrooms
              and assignments.
            </p>
            <ButtonLink href="/signin">Sign in</ButtonLink>
          </div>
        </main>
      </>
    )
  }

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
              <EmptyState
                title="No classrooms yet"
                description="Open the invite link your instructor sent you to join one. If you teach here and need to create classrooms, ask a site administrator for a faculty invitation."
              />
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
