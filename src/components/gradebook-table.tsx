'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import { setManualScore } from '@/lib/canvas/gradeActions'

export type GradeCell = {
  assignmentId: string
  repoId: string | null
  score: number | null
  isManual: boolean
  note: string | null
}

export type GradebookStudent = {
  id: string
  displayName: string
  sisLoginId: string | null
  githubLogin: string | null
  registered: boolean
  cells: GradeCell[]
}

export type GradebookAssignment = {
  id: string
  title: string
  pointsPossible: number
}

/**
 * Gradebook with inline overrides and Canvas export.
 *
 * A blank cell means "no score", never zero — the distinction matters because
 * exporting a zero actively records a failing grade in Canvas, while a blank leaves
 * the existing value alone.
 */
export function GradebookTable({
  classroomSlug,
  canEdit,
  assignments,
  students,
}: {
  classroomSlug: string
  canEdit: boolean
  assignments: GradebookAssignment[]
  students: GradebookStudent[]
}) {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [includePoints, setIncludePoints] = useState(false)
  const [pending, startTransition] = useTransition()

  const registered = students.filter((s) => s.registered).length
  const missing = students.reduce(
    (count, s) => count + s.cells.filter((c) => c.score === null).length,
    0,
  )

  function save(repoId: string) {
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentRepoId', repoId)
      fd.set('score', draft)

      const result = await setManualScore(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setEditing(null)
      setDraft('')
      router.refresh()
    })
  }

  const exportHref =
    `/classrooms/${classroomSlug}/grades/export` + (includePoints ? '?points=1' : '')

  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Export to Canvas</CardTitle>
          <CardDescription>
            Downloads a CSV for <strong>Grades → Import</strong> in Canvas. Identity columns
            come straight from the file you imported, so Canvas matches your existing students
            rather than creating new ones.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <Stat label="Students" value={students.length} />
            <Stat label="Registered" value={registered} tone={registered < students.length ? 'warning' : 'success'} />
            <Stat label="Blank cells" value={missing} tone={missing > 0 ? 'warning' : 'success'} />
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={includePoints}
              onChange={(e) => setIncludePoints(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Include a “Points Possible” row
              <span className="block text-xs text-muted">
                Leave this off unless you want the import to set each assignment’s point value.
                With it off, Canvas keeps whatever you have configured there.
              </span>
            </span>
          </label>

          <p className="text-xs text-muted">
            Blank cells are left untouched by Canvas — they do not record a zero. Students who
            have not linked a GitHub account export as blank rows.
          </p>

          <div>
            <a
              href={exportHref}
              className="inline-flex items-center rounded-md bg-accent-bright text-accent-contrast px-4 h-10 text-sm font-semibold hover:brightness-95"
            >
              Download CSV
            </a>
          </div>
        </CardContent>
      </Card>

      {students.length === 0 || assignments.length === 0 ? (
        <div className="rounded-lg border border-border">
          <EmptyState
            title={students.length === 0 ? 'No students on the roster' : 'No assignments yet'}
            description={
              students.length === 0
                ? 'Import a Canvas roster first.'
                : 'Create an assignment to start recording grades.'
            }
          />
        </div>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="sticky left-0 bg-surface-subtle z-10">Student</Th>
                {assignments.map((a) => (
                  <Th key={a.id} className="text-right">
                    <span className="block">{a.title}</span>
                    <span className="block text-xs font-normal text-muted">
                      / {a.pointsPossible}
                    </span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <Td className="sticky left-0 bg-surface z-10">
                    <span className="font-medium">{student.displayName}</span>
                    <span className="block text-xs text-muted">
                      {student.registered ? (
                        student.githubLogin ? (
                          <span className="font-mono">@{student.githubLogin}</span>
                        ) : null
                      ) : (
                        <Badge tone="warning">not registered</Badge>
                      )}
                    </span>
                  </Td>

                  {student.cells.map((cell) => {
                    const key = `${student.id}:${cell.assignmentId}`
                    const isEditing = editing === key

                    return (
                      <Td key={cell.assignmentId} className="text-right whitespace-nowrap">
                        {isEditing && cell.repoId ? (
                          <span className="inline-flex items-center gap-1">
                            <Input
                              aria-label={`Score for ${student.displayName}`}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') save(cell.repoId!)
                                if (e.key === 'Escape') setEditing(null)
                              }}
                              className="w-20 h-8 text-right"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => save(cell.repoId!)}
                            >
                              Save
                            </Button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`rounded px-2 py-0.5 ${
                              canEdit && cell.repoId ? 'hover:bg-surface-subtle cursor-pointer' : 'cursor-default'
                            }`}
                            title={
                              cell.note ??
                              (cell.isManual ? 'Manually overridden' : undefined)
                            }
                            disabled={!canEdit || !cell.repoId}
                            onClick={() => {
                              if (!canEdit || !cell.repoId) return
                              setEditing(key)
                              setDraft(cell.score === null ? '' : String(cell.score))
                            }}
                          >
                            {cell.score === null ? (
                              <span className="text-muted">—</span>
                            ) : (
                              <span className={cell.isManual ? 'font-semibold text-info' : ''}>
                                {cell.score}
                              </span>
                            )}
                          </button>
                        )}
                      </Td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      {canEdit ? (
        <p className="text-xs text-muted">
          Click any score to override it. An override (shown in blue) always wins over the
          autograded value on export. Clear the field to go back to the autograded score. A dash
          means no score — it exports as blank, not zero.
        </p>
      ) : null}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'success' | 'warning' | 'neutral'
}) {
  const color =
    tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-foreground'
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  )
}
