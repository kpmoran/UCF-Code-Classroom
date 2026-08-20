import Link from 'next/link'

import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { JoinClassroomButton } from '@/components/join-classroom-button'
import { requireSiteAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'

/**
 * Every classroom on the instance.
 *
 * This existed nowhere before: site admins could reach any classroom by URL, but
 * nothing listed them, so finding a colleague's course meant guessing a slug from
 * its course code and term, or reading the database. That is a poor position to
 * operate from — particularly for the case this is most needed for, which is finding
 * a classroom whose instructor has left.
 *
 * Deliberately metadata only: names, terms, organizations, counts, who teaches it.
 * No student appears on this page, and the rows link to a classroom's overview,
 * which is also counts. Reading a roster or a gradebook requires being a member of
 * that classroom — see `requireEnrolledStaff` — and the button below is the recorded
 * way to become one.
 */
export default async function AdminClassroomsPage() {
  const admin = await requireSiteAdmin()

  const classrooms = await db.classroom.findMany({
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      slug: true,
      name: true,
      courseCode: true,
      term: true,
      githubOrgLogin: true,
      archivedAt: true,
      createdAt: true,
      _count: { select: { rosterEntries: true, assignments: true } },
      members: {
        where: { role: 'INSTRUCTOR' },
        select: { userId: true, user: { select: { name: true, githubLogin: true } } },
        orderBy: { joinedAt: 'asc' },
      },
    },
  })

  const active = classrooms.filter((c) => c.archivedAt === null)

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
        <div>
          <Link href="/admin/faculty" className="text-sm text-muted hover:underline">
            ← Faculty access
          </Link>
          <h1 className="text-2xl font-semibold mt-2">All classrooms</h1>
          <p className="text-sm text-muted mt-1">
            {classrooms.length === 0
              ? 'No classrooms yet.'
              : `${classrooms.length} classroom${classrooms.length === 1 ? '' : 's'} on this server, ${active.length} active.`}
          </p>
        </div>

        {classrooms.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted">
              Nothing here yet. Classrooms appear as faculty create them.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Every course on this server</CardTitle>
              <CardDescription>
                Rosters and grades are not shown here, and are not readable from an
                account that is not a member of the classroom. Join a classroom to work
                in it; doing so is recorded in its activity log.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-strong text-left">
                      <th scope="col" className="px-5 py-2 font-medium text-muted">
                        Classroom
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium text-muted">
                        Instructors
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium text-muted">
                        Organization
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium text-muted text-right">
                        Students
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium text-muted text-right">
                        Assignments
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium text-muted">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {classrooms.map((c) => {
                      const isMember = c.members.some((m) => m.userId === admin.id)
                      const instructors = c.members
                        .map((m) => m.user.githubLogin ?? m.user.name)
                        .filter(Boolean)

                      return (
                        <tr key={c.id} className="border-b border-border last:border-0">
                          <td className="px-5 py-3">
                            <Link
                              href={`/classrooms/${c.slug}`}
                              className="font-medium hover:underline"
                            >
                              {c.name}
                            </Link>
                            <div className="text-xs text-muted mt-0.5">
                              {[c.courseCode, c.term].filter(Boolean).join(' · ') || c.slug}
                              {c.archivedAt ? (
                                <>
                                  {' '}
                                  <Badge tone="neutral">Archived</Badge>
                                </>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            {instructors.length === 0 ? (
                              // Worth flagging rather than leaving blank: it is the state
                              // this page is most useful for finding.
                              <Badge tone="warning">No instructor</Badge>
                            ) : (
                              <span className="font-mono text-xs">
                                {instructors.join(', ')}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <a
                              href={`https://github.com/${c.githubOrgLogin}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-xs hover:underline"
                            >
                              {c.githubOrgLogin}
                            </a>
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums">
                            {c._count.rosterEntries}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums">
                            {c._count.assignments}
                          </td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            {isMember ? (
                              <Badge tone="success">Joined</Badge>
                            ) : (
                              <JoinClassroomButton classroomId={c.id} name={c.name} />
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  )
}
