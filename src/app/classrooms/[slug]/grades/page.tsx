import Link from 'next/link'

import { GradebookTable } from '@/components/gradebook-table'
import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'
import { requireStaff } from '@/lib/auth/dal'
import { columnTitle, resolveScore } from '@/lib/canvas/exportGrades'
import { db } from '@/lib/db'

export default async function GradesPage(props: PageProps<'/classrooms/[slug]/grades'>) {
  const { slug } = await props.params
  const { classroom, role } = await requireStaff(slug)

  const [assignments, roster] = await Promise.all([
    db.assignment.findMany({
      where: { classroomId: classroom.id },
      orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        totalPoints: true,
        gradingTests: { select: { points: true } },
        repos: {
          select: {
            id: true,
            userId: true,
            manualScore: true,
            manualScoreNote: true,
            team: { select: { members: { select: { userId: true } } } },
            autogradeRuns: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { score: true, status: true },
            },
          },
        },
      },
    }),
    db.rosterEntry.findMany({
      where: { classroomId: classroom.id, removedAt: null },
      orderBy: { displayName: 'asc' },
      select: {
        id: true,
        displayName: true,
        sisLoginId: true,
        claimedByUserId: true,
        claimedByUser: { select: { githubLogin: true } },
      },
    }),
  ])

  // Index each assignment's scores by the student who should receive them; a team
  // repository's score belongs to every member.
  const byAssignment = assignments.map((assignment) => {
    const cells = new Map<
      string,
      { repoId: string; score: number | null; manual: number | null; note: string | null }
    >()

    for (const repo of assignment.repos) {
      const run = repo.autogradeRuns[0]
      const score = resolveScore({
        manualScore: repo.manualScore,
        autogradeScore: run?.score ?? null,
        autogradeStatus: run?.status ?? null,
      })
      const cell = {
        repoId: repo.id,
        score,
        manual: repo.manualScore,
        note: repo.manualScoreNote,
      }

      if (repo.userId) cells.set(repo.userId, cell)
      else if (repo.team) for (const m of repo.team.members) cells.set(m.userId, cell)
    }

    return {
      id: assignment.id,
      title: columnTitle(assignment.title),
      pointsPossible:
        assignment.gradingTests.reduce((sum, t) => sum + t.points, 0) || assignment.totalPoints,
      cells,
    }
  })

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-7xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div>
              <h1 className="text-2xl font-semibold">Grades</h1>
              <p className="text-sm text-muted mt-1">
                {roster.length} student{roster.length === 1 ? '' : 's'} ·{' '}
                {assignments.length} assignment{assignments.length === 1 ? '' : 's'}
              </p>
            </div>
            <ButtonLink href={`/classrooms/${classroom.slug}/roster`} variant="outline" size="sm">
              Roster
            </ButtonLink>
          </div>
        </div>

        <GradebookTable
          classroomSlug={classroom.slug}
          canEdit={role === 'INSTRUCTOR'}
          assignments={byAssignment.map((a) => ({
            id: a.id,
            title: a.title,
            pointsPossible: a.pointsPossible,
          }))}
          students={roster.map((entry) => ({
            id: entry.id,
            displayName: entry.displayName,
            sisLoginId: entry.sisLoginId,
            githubLogin: entry.claimedByUser?.githubLogin ?? null,
            registered: entry.claimedByUserId !== null,
            cells: byAssignment.map((a) => {
              const cell = entry.claimedByUserId ? a.cells.get(entry.claimedByUserId) : undefined
              return {
                assignmentId: a.id,
                repoId: cell?.repoId ?? null,
                score: cell?.score ?? null,
                isManual: cell?.manual !== null && cell?.manual !== undefined,
                note: cell?.note ?? null,
              }
            }),
          }))}
        />
      </main>
    </>
  )
}
