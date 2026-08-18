import 'server-only'

import { db } from '@/lib/db'

import {
  buildGradeCsv,
  columnTitle,
  resolveScore,
  type ExportColumn,
  type ExportRow,
} from './exportGrades'

/**
 * Assemble the grade export for a classroom.
 *
 * Kept apart from the CSV builder so the formatting rules stay pure and testable
 * while the querying lives here.
 */

export type GradeExportSummary = {
  csv: string
  studentCount: number
  assignmentCount: number
  /** Students on the roster who never linked a GitHub account. */
  unregistered: number
  /** Cells with no score, so the instructor knows how much is still blank. */
  missingScores: number
  warnings: string[]
}

export async function buildClassroomGradeExport(
  classroomId: string,
  options: { assignmentIds?: string[]; includePointsPossible?: boolean } = {},
): Promise<GradeExportSummary> {
  const assignments = await db.assignment.findMany({
    where: {
      classroomId,
      ...(options.assignmentIds?.length ? { id: { in: options.assignmentIds } } : {}),
    },
    orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      type: true,
      totalPoints: true,
      gradingTests: { select: { points: true } },
      repos: {
        select: {
          userId: true,
          teamId: true,
          manualScore: true,
          team: { select: { members: { select: { userId: true } } } },
          autogradeRuns: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { score: true, status: true },
          },
        },
      },
    },
  })

  const roster = await db.rosterEntry.findMany({
    where: { classroomId, removedAt: null },
    orderBy: { displayName: 'asc' },
    select: {
      displayName: true,
      rawColumns: true,
      claimedByUserId: true,
    },
  })

  const warnings: string[] = []

  // Two assignments with the same title would collide into one Canvas column and
  // silently overwrite each other.
  const titles = new Map<string, string[]>()
  for (const assignment of assignments) {
    const title = columnTitle(assignment.title)
    titles.set(title, [...(titles.get(title) ?? []), assignment.id])
  }
  for (const [title, ids] of titles) {
    if (ids.length > 1) {
      warnings.push(
        `${ids.length} assignments are both called “${title}”. They would share one Canvas ` +
          'column and overwrite each other — rename one before importing.',
      )
    }
  }

  const columns: ExportColumn[] = assignments.map((assignment) => ({
    title: columnTitle(assignment.title),
    // Prefer the configured autograding total; fall back to the stored value, which
    // an instructor may have set by hand.
    pointsPossible:
      assignment.gradingTests.reduce((sum, t) => sum + t.points, 0) || assignment.totalPoints,
  }))

  // Score lookup per assignment, resolved to the user who should receive it. A team
  // repository's score goes to every member.
  const scoresByAssignment = new Map<string, Map<string, number | null>>()

  for (const assignment of assignments) {
    const perUser = new Map<string, number | null>()

    for (const repo of assignment.repos) {
      const run = repo.autogradeRuns[0]
      const score = resolveScore({
        manualScore: repo.manualScore,
        autogradeScore: run?.score ?? null,
        autogradeStatus: run?.status ?? null,
      })

      if (repo.userId) {
        perUser.set(repo.userId, score)
      } else if (repo.team) {
        // Every member of a team receives the team's score.
        for (const member of repo.team.members) perUser.set(member.userId, score)
      }
    }

    scoresByAssignment.set(assignment.id, perUser)
  }

  let unregistered = 0
  let missingScores = 0

  const rows: ExportRow[] = roster.map((entry) => {
    if (!entry.claimedByUserId) unregistered += 1

    const scores: Record<string, number | null> = {}
    for (const [index, assignment] of assignments.entries()) {
      const title = columns[index].title
      const score = entry.claimedByUserId
        ? (scoresByAssignment.get(assignment.id)?.get(entry.claimedByUserId) ?? null)
        : null
      scores[title] = score
      if (score === null) missingScores += 1
    }

    return {
      // The verbatim Canvas row is what makes the import match rather than
      // duplicate; see exportGrades.ts.
      rawColumns: (entry.rawColumns ?? {}) as Record<string, string>,
      displayName: entry.displayName,
      scores,
    }
  })

  if (unregistered > 0) {
    warnings.push(
      `${unregistered} student${unregistered === 1 ? '' : 's'} on the roster ` +
        `${unregistered === 1 ? 'has' : 'have'} not linked a GitHub account, so ` +
        `${unregistered === 1 ? 'their row is' : 'their rows are'} blank.`,
    )
  }

  return {
    csv: buildGradeCsv(rows, columns, {
      includePointsPossible: options.includePointsPossible,
    }),
    studentCount: rows.length,
    assignmentCount: columns.length,
    unregistered,
    missingScores,
    warnings,
  }
}
