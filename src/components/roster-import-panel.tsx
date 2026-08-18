'use client'

import { useState, useTransition } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Label } from '@/components/ui/input'
import {
  applyRosterImport,
  previewRosterImport,
  type RosterPreview,
} from '@/lib/roster/actions'

/**
 * Two-step roster import: upload, review the exact consequences, then confirm.
 *
 * The review step is not decoration. A wrong CSV — the previous term's export, or
 * one missing SIS permissions — would otherwise remove students who have already
 * linked their GitHub account and been given repositories. Removals are opt-in
 * for the same reason.
 */
export function RosterImportPanel({
  classroomId,
  hasExisting,
}: {
  classroomId: string
  hasExisting: boolean
}) {
  const [preview, setPreview] = useState<RosterPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [applyRemovals, setApplyRemovals] = useState(false)
  const [pending, startTransition] = useTransition()

  function onUpload(formData: FormData) {
    setError(null)
    setApplied(null)
    formData.set('classroomId', classroomId)
    startTransition(async () => {
      const result = await previewRosterImport(formData)
      if (result.ok) {
        setPreview(result)
        // Default to not removing anyone; the instructor opts in after reading.
        setApplyRemovals(false)
      } else {
        setPreview(null)
        setError(result.error)
      }
    })
  }

  function onApply() {
    if (!preview) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set('classroomId', classroomId)
      formData.set('csv', preview.csv)
      if (applyRemovals) formData.set('applyRemovals', 'on')

      const result = await applyRosterImport(formData)
      if (result.ok) {
        const { added, updated, removed } = result.data
        setApplied(
          `Imported: ${added} added, ${updated} updated, ${removed} removed.`,
        )
        setPreview(null)
      } else {
        setError(result.error)
      }
    })
  }

  const d = preview?.diff
  const nothingToDo =
    d && d.added.length === 0 && d.updated.length === 0 && d.removed.length === 0 && d.restored.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import roster from Canvas</CardTitle>
        <CardDescription>
          In Canvas, go to <strong>Grades → Export → Export Entire Gradebook</strong>, then
          upload the CSV here. Nothing changes until you confirm.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2 whitespace-pre-line">
            {error}
          </p>
        ) : null}
        {applied ? (
          <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
            {applied}
          </p>
        ) : null}

        {!preview ? (
          <form action={onUpload} className="space-y-3">
            <div>
              <Label htmlFor="file">Canvas Gradebook CSV</Label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
              />
              <FieldHint>
                {hasExisting
                  ? 'Re-importing updates the existing roster; it does not start over.'
                  : 'The first import creates the roster.'}
              </FieldHint>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Reading…' : 'Preview changes'}
            </Button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="text-sm">
              <p className="font-medium">{preview.fileName}</p>
              <p className="text-muted">
                {preview.parse.totalRows} student row
                {preview.parse.totalRows === 1 ? '' : 's'} parsed
              </p>
            </div>

            {/* Which columns were understood — the quickest way to spot a bad export. */}
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(preview.parse.matchedColumns).map(([field, header]) => (
                <Badge key={field} tone={header ? 'success' : 'warning'}>
                  {field}: {header ?? 'not found'}
                </Badge>
              ))}
            </div>

            {preview.parse.warnings.length > 0 ? (
              <div className="rounded-md bg-warning-subtle text-warning px-3 py-2 text-sm space-y-1">
                {preview.parse.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            ) : null}

            {preview.parse.skipped.length > 0 ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">
                  {preview.parse.skipped.length} row
                  {preview.parse.skipped.length === 1 ? '' : 's'} skipped
                </summary>
                <ul className="mt-2 space-y-1 text-muted">
                  {preview.parse.skipped.map((s) => (
                    <li key={`${s.line}-${s.value}`}>
                      Line {s.line}: {s.value || '(blank)'} — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-4 text-sm">
              <Stat label="Add" value={d!.added.length} tone="success" />
              <Stat label="Update" value={d!.updated.length + d!.restored.length} tone="info" />
              <Stat label="Unchanged" value={d!.unchangedCount} tone="neutral" />
              <Stat label="Not in file" value={d!.removed.length} tone={d!.removed.length ? 'warning' : 'neutral'} />
            </div>

            {d!.added.length > 0 ? (
              <DiffList title="Will be added">
                {d!.added.map((a) => (
                  <li key={`${a.sisUserId}-${a.displayName}`}>
                    {a.displayName}
                    {a.section ? <span className="text-muted"> · {a.section}</span> : null}
                  </li>
                ))}
              </DiffList>
            ) : null}

            {d!.updated.length > 0 ? (
              <DiffList title="Will be updated">
                {d!.updated.map((u) => (
                  <li key={u.id}>
                    {u.displayName}
                    <span className="text-muted">
                      {' — '}
                      {u.changes
                        .map((c) => `${c.field}: ${c.from ?? '(none)'} → ${c.to ?? '(none)'}`)
                        .join(', ')}
                    </span>
                  </li>
                ))}
              </DiffList>
            ) : null}

            {d!.restored.length > 0 ? (
              <DiffList title="Will be restored (previously removed)">
                {d!.restored.map((r) => (
                  <li key={r.id}>{r.displayName}</li>
                ))}
              </DiffList>
            ) : null}

            {d!.removed.length > 0 ? (
              <div className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-3 space-y-3">
                <div>
                  <p className="text-sm font-medium text-warning">
                    {d!.removed.length} student{d!.removed.length === 1 ? '' : 's'} on the
                    roster {d!.removed.length === 1 ? 'is' : 'are'} not in this file
                  </p>
                  <p className="text-xs text-warning mt-1">
                    Usually this means they dropped the course. If it looks like too many,
                    you may have exported the wrong section or term — leave the box unticked
                    and re-export.
                  </p>
                </div>

                <ul className="text-sm space-y-0.5">
                  {d!.removed.map((r) => (
                    <li key={r.id}>
                      {r.displayName}
                      {r.claimed ? <Badge tone="danger" className="ml-2">registered</Badge> : null}
                    </li>
                  ))}
                </ul>

                {d!.destructive.length > 0 ? (
                  <div className="space-y-1 border-t border-warning/30 pt-2">
                    <p className="text-xs font-medium text-warning">
                      These students have already registered:
                    </p>
                    {d!.destructive.map((x) => (
                      <p key={x.id} className="text-xs text-warning">
                        {x.consequence}
                      </p>
                    ))}
                  </div>
                ) : null}

                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={applyRemovals}
                    onChange={(e) => setApplyRemovals(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Also remove {d!.removed.length} student
                    {d!.removed.length === 1 ? '' : 's'} from the roster
                    <span className="block text-xs text-muted">
                      No GitHub repositories are deleted. Removals can be undone from the
                      roster table.
                    </span>
                  </span>
                </label>
              </div>
            ) : null}

            {nothingToDo ? (
              <p className="text-sm text-muted">
                This file matches the current roster exactly — nothing to apply.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>

      {preview ? (
        <CardFooter className="flex justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPreview(null)
              setError(null)
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={onApply}
            disabled={pending || nothingToDo}
          >
            {pending ? 'Applying…' : 'Apply changes'}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'info' | 'neutral' | 'warning'
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'info'
        ? 'text-info'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-foreground'
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  )
}

function DiffList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="text-sm">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-2 space-y-0.5 pl-4 list-disc">{children}</ul>
    </details>
  )
}
