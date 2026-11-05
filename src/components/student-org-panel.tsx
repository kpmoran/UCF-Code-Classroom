'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  inviteStudentsToOrg,
  recheckOrgInvitations,
  removeStudentsFromOrg,
  setStudentOrgAccess,
} from '@/lib/students/actions'

/** Students by organization state, as the settings page counts them. */
export type OrgStateCounts = {
  notInvited: number
  pending: number
  expired: number
  failed: number
  active: number
  removed: number
}

type RemovalMode = 'CONVERT' | 'REMOVE'

/**
 * Organization membership for students: the switch, where the class stands, and
 * the end-of-term removal.
 *
 * The removal is confirmed by typing the slug, as archiving is, because it reaches
 * every student at once; and it asks what should happen to their repository access
 * with no default, because the two answers are both reasonable and nobody should
 * discover which one applied by finding their repositories gone.
 */
export function StudentOrgPanel({
  classroomId,
  slug,
  enabled,
  archived,
  counts,
}: {
  classroomId: string
  slug: string
  enabled: boolean
  archived: boolean
  counts: OrgStateCounts
}) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [removing, setRemoving] = useState(false)
  const [mode, setMode] = useState<RemovalMode>('CONVERT')
  const [dialogError, setDialogError] = useState<string | null>(null)

  type Result<T> = { ok: true; data: T } | { ok: false; error: string }

  function run<T>(
    action: (fd: FormData) => Promise<Result<T>>,
    extra: Record<string, string>,
    describe: (data: T) => string,
  ) {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      for (const [k, v] of Object.entries(extra)) fd.set(k, v)
      const result = await action(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage(describe(result.data))
      router.refresh()
    })
  }

  function confirmRemoval() {
    setDialogError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      fd.set('mode', mode)
      fd.set('confirmSlug', slug)
      const result = await removeStudentsFromOrg(fd)
      if (!result.ok) {
        setDialogError(result.error)
        return
      }
      setRemoving(false)
      setMessage(
        result.data.queued === 0
          ? 'Nobody to remove.'
          : `${plural(result.data.queued, 'student')} ${
              mode === 'CONVERT' ? 'being converted to outside collaborators' : 'being removed'
            }. The people page shows each one as it is done.`,
      )
      router.refresh()
    })
  }

  const needing = counts.notInvited + counts.expired + counts.failed
  const outstanding = counts.pending + counts.expired
  const inOrg = counts.pending + counts.active + counts.expired

  return (
    <div className="space-y-4 text-sm">
      {message ? (
        <p role="status" className="rounded-md bg-success-subtle text-success px-3 py-2">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p>
          <span className="font-medium">{enabled ? 'On.' : 'Off.'}</span>{' '}
          <span className="text-muted">
            {enabled
              ? 'Students are invited to the organization when they join, and get each assignment repository directly.'
              : 'Students are invited to each assignment repository separately, and each invitation expires after seven days.'}
          </span>
        </p>
        <Button
          variant="outline"
          disabled={pending || archived}
          onClick={() =>
            run(
              setStudentOrgAccess,
              { enabled: enabled ? 'false' : 'true' },
              (data) =>
                data.enabled
                  ? data.queued > 0
                    ? `Turned on. Inviting ${plural(data.queued, 'student')} now; GitHub will email each of them.`
                    : 'Turned on. Students are invited as they join.'
                  : 'Turned off. Nobody has been removed from the organization.',
            )
          }
        >
          {pending ? 'Working…' : enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>

      {enabled ? (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Stat label="not invited" value={counts.notInvited} />
            <Stat label="invited" value={counts.pending} />
            <Stat label="expired" value={counts.expired} tone={counts.expired > 0 ? 'warning' : undefined} />
            <Stat label="failed" value={counts.failed} tone={counts.failed > 0 ? 'danger' : undefined} />
            <Stat label="members" value={counts.active} tone="success" />
          </dl>

          <div className="flex gap-2 flex-wrap">
            {needing > 0 ? (
              <Button
                variant="outline"
                disabled={pending || archived}
                onClick={() =>
                  run(inviteStudentsToOrg, {}, (data) =>
                    data.queued === 0
                      ? 'Nobody needs an invitation.'
                      : `Inviting ${plural(data.queued, 'student')}. GitHub will email each of them within a few minutes.`,
                  )
                }
              >
                Invite {plural(needing, 'student')}
              </Button>
            ) : null}
            {outstanding > 0 ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(recheckOrgInvitations, {}, (data) =>
                    data.checked === 0
                      ? 'No outstanding invitations to check.'
                      : data.activated === 0
                        ? `Asked GitHub about ${plural(data.checked, 'invitation')} — none accepted yet.`
                        : `${data.activated} of ${plural(data.checked, 'invitation')} ${
                            data.activated === 1 ? 'has' : 'have'
                          } been accepted.`,
                  )
                }
              >
                Re-check {plural(outstanding, 'invitation')}
              </Button>
            ) : null}
          </div>
          <p className="text-muted">
            A student whose invitation expired can request a new one from their classroom
            page, and the people page lets you resend any one of them.
          </p>
        </>
      ) : null}

      {inOrg > 0 ? (
        <div className="border-t border-border pt-4 space-y-2">
          <p className="font-medium">End of term</p>
          <p className="text-muted">
            Take the {plural(inOrg, 'student')} this classroom invited out of the
            organization. Anyone who was already a member, or whom another classroom here
            still needs, is left alone. Best done after archiving.
          </p>
          <Button variant="outline" disabled={pending} onClick={() => setRemoving(true)}>
            Remove students from the organization…
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={removing}
        title="Remove students from the organization?"
        confirmLabel={mode === 'CONVERT' ? 'Convert students' : 'Remove students'}
        destructive={mode === 'REMOVE'}
        busy={pending}
        error={dialogError}
        confirmText={slug}
        onCancel={() => {
          if (pending) return
          setRemoving(false)
          setDialogError(null)
        }}
        onConfirm={confirmRemoval}
        description={
          <p>
            Applies to the {plural(inOrg, 'student')} this classroom invited. Pending
            invitations are cancelled either way.
          </p>
        }
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Their repository access</legend>
          {(
            [
              [
                'CONVERT',
                'Keep it, as outside collaborators',
                'They leave the organization but can still reach their own repositories. Nobody loses their work.',
              ],
              [
                'REMOVE',
                'Remove it with their membership',
                'They lose access to every repository in the organization, including their own.',
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={`flex gap-2 items-start rounded-md border px-3 py-2 cursor-pointer text-sm ${
                mode === value ? 'border-accent bg-surface-subtle' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name="mode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value)
                  setDialogError(null)
                }}
                className="mt-0.5"
              />
              <span>
                <span className={value === 'REMOVE' ? 'font-medium text-danger' : 'font-medium'}>
                  {label}
                </span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </ConfirmDialog>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'success' | 'warning' | 'danger'
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : ''
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-lg font-semibold ${color}`}>{value}</dd>
    </div>
  )
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
