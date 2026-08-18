import Link from 'next/link'

import { PeopleTable } from '@/components/people-table'
import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'
import { requireStaff } from '@/lib/auth/dal'
import { db } from '@/lib/db'

export default async function PeoplePage(props: PageProps<'/classrooms/[slug]/people'>) {
  const { slug } = await props.params
  const { classroom, role, user } = await requireStaff(slug)

  const members = await db.classroomMember.findMany({
    where: { classroomId: classroom.id },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    select: {
      role: true,
      joinedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          githubLogin: true,
          claimedRosterEntry: { select: { displayName: true, classroomId: true } },
        },
      },
    },
  })

  // Repository counts per member, so a removal can state what it affects.
  const userIds = members.map((m) => m.user.id)
  const repoCounts = new Map<string, number>()
  if (userIds.length > 0) {
    const grouped = await db.assignmentRepo.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, assignment: { classroomId: classroom.id } },
      _count: { _all: true },
    })
    for (const row of grouped) {
      if (row.userId) repoCounts.set(row.userId, row._count._all)
    }
  }

  const instructorCount = members.filter((m) => m.role === 'INSTRUCTOR').length

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div>
              <h1 className="text-2xl font-semibold">People</h1>
              <p className="text-sm text-muted mt-1">
                {members.length} member{members.length === 1 ? '' : 's'} ·{' '}
                {instructorCount} instructor{instructorCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex gap-2">
              <ButtonLink href={`/classrooms/${classroom.slug}/roster`} variant="outline" size="sm">
                Roster
              </ButtonLink>
              <ButtonLink href={`/classrooms/${classroom.slug}/audit`} variant="outline" size="sm">
                Activity log
              </ButtonLink>
            </div>
          </div>
        </div>

        <p className="text-sm text-muted">
          Members are people who have signed in and joined. The{' '}
          <Link href={`/classrooms/${classroom.slug}/roster`} className="underline">
            roster
          </Link>{' '}
          is the list imported from Canvas — a student appears here only once they have
          claimed their roster entry.
        </p>

        <PeopleTable
          classroomId={classroom.id}
          canManage={role === 'INSTRUCTOR'}
          currentUserId={user.id}
          instructorCount={instructorCount}
          members={members.map((m) => ({
            userId: m.user.id,
            role: m.role,
            name:
              m.user.claimedRosterEntry?.classroomId === classroom.id
                ? m.user.claimedRosterEntry.displayName
                : (m.user.name ?? m.user.githubLogin ?? 'Unknown'),
            githubLogin: m.user.githubLogin,
            email: m.user.email,
            joinedAt: m.joinedAt.toISOString(),
            repoCount: repoCounts.get(m.user.id) ?? 0,
            isYou: m.user.id === user.id,
          }))}
        />
      </main>
    </>
  )
}
