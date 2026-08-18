'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Input, Label, Select } from '@/components/ui/input'
import {
  grantExtension,
  revokeExtension,
  runDeadlineSweep,
  setAssignmentDeadline,
} from '@/lib/deadlines/actions'

export type ExtensionRow = {
  id: string
  newDeadline: string
  reason: string | null
  who: string
  kind: 'student' | 'team'
}

export type ExtensionTarget = {
  id: string
  label: string
  kind: 'student' | 'team'
}

/**
 * Deadline and extension management for staff.
 *
 * The lock state is described in terms of what it does to students — write access
 * — rather than as an internal flag, because that is the thing an instructor is
 * deciding about.
 */
export function DeadlinePanel({
  assignmentId,
  deadline,
  lockOnDeadline,
  lockedCount,
  extensions,
  targets,
}: {
  assignmentId: string
  /** `datetime-local` value, or empty for no deadline. */
  deadline: string
  lockOnDeadline: boolean
  lockedCount: number
  extensions: ExtensionRow[]
  targets: ExtensionTarget[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [targetId, setTargetId] = useState('')
  const [newDeadline, setNewDeadline] = useState('')
  const [reason, setReason] = useState('')

  // Initialised from props, then owned by the form. `router.refresh()` re-renders
  // with the same props and does not reset state, so an edit in progress survives
  // a background refresh.
  const [deadlineField, setDeadlineField] = useState(deadline)
  const [lockField, setLockField] = useState(lockOnDeadline)

  function run(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    extra: Record<string, string>,
    successMessage?: string,
  ) {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      for (const [k, v] of Object.entries(extra)) fd.set(k, v)
      const result = await action(fd)
      if (!result.ok) {
        setError(result.error ?? 'That did not work.')
        return
      }
      if (successMessage) setMessage(successMessage)
      setTargetId('')
      setNewDeadline('')
      setReason('')
      router.refresh()
    })
  }

  const selectedTarget = targets.find((t) => t.id === targetId)

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
          {message}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Deadline</CardTitle>
          <CardDescription>
            {deadline
              ? 'Applies to everyone without an extension.'
              : 'No deadline set — nothing is ever marked late.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="assignmentDeadline">Due</Label>
              <Input
                id="assignmentDeadline"
                type="datetime-local"
                value={deadlineField}
                onChange={(e) => setDeadlineField(e.target.value)}
              />
              <FieldHint>Leave empty for no deadline.</FieldHint>
            </div>
            <div className="flex items-end">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={lockField}
                  onChange={(e) => setLockField(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Revoke write access at the deadline
                  <span className="block text-xs text-muted">
                    Students keep read access and can still clone. An extension restores
                    write access automatically.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {lockedCount > 0 ? (
            <p className="text-sm rounded-md bg-warning-subtle text-warning px-3 py-2">
              {lockedCount} repositor{lockedCount === 1 ? 'y is' : 'ies are'} currently
              read-only because the deadline passed.
            </p>
          ) : null}

          <p className="text-xs text-muted">
            The submitted commit is recorded at the deadline whether or not write access is
            revoked, so late work is always distinguishable from on-time work.
          </p>
        </CardContent>
        <CardFooter className="flex justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => run(runDeadlineSweep, {}, 'Deadline check queued.')}
          >
            Re-check now
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                setAssignmentDeadline,
                {
                  deadline: deadlineField,
                  ...(lockField ? { lockOnDeadline: 'on' } : {}),
                },
                'Deadline saved.',
              )
            }
          >
            {pending ? 'Saving…' : 'Save deadline'}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Extensions</CardTitle>
          <CardDescription>
            {extensions.length === 0
              ? 'No extensions granted.'
              : `${extensions.length} extension${extensions.length === 1 ? '' : 's'} in force.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {extensions.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {extensions.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {e.who}{' '}
                      <Badge tone={e.kind === 'team' ? 'info' : 'neutral'}>{e.kind}</Badge>
                    </p>
                    <p className="text-xs text-muted">
                      until{' '}
                      {new Date(e.newDeadline).toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {e.reason ? ` — ${e.reason}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(revokeExtension, { extensionId: e.id }, 'Extension withdrawn.')
                    }
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Grant an extension</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="extensionTarget">Student or team</Label>
                <Select
                  id="extensionTarget"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="extensionDeadline">New deadline</Label>
                <Input
                  id="extensionDeadline"
                  type="datetime-local"
                  value={newDeadline}
                  onChange={(e) => setNewDeadline(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="extensionReason">Reason</Label>
              <Input
                id="extensionReason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                placeholder="Optional — recorded in the activity log"
              />
            </div>

            <Button
              variant="accent"
              disabled={pending || !targetId || !newDeadline}
              onClick={() =>
                run(
                  grantExtension,
                  {
                    ...(selectedTarget?.kind === 'team'
                      ? { teamId: targetId }
                      : { userId: targetId }),
                    newDeadline,
                    reason,
                  },
                  'Extension granted.',
                )
              }
            >
              {pending ? 'Granting…' : 'Grant extension'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
