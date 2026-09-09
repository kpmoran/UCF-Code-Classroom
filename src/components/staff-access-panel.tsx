'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { grantStaffAccess } from '@/lib/staff/actions'

/**
 * Staff access to student repositories.
 *
 * Worth stating plainly in the UI, because the app's own roles are misleading on
 * this point: making someone a TA in Code Classroom grants them nothing on GitHub.
 * Provisioning adds one collaborator — the student — so before this existed an
 * instructor could read student work only by being an organization owner, and a TA
 * who was a plain organization member could read none of it. The symptom is a TA
 * reporting that every repository 404s, which looks like a bug rather than a
 * permission that was never granted.
 */
export function StaffAccessPanel({
  classroomId,
  assignmentId,
  orgLogin,
  teamSlug,
  staffCount,
  unlinkedStaff,
  repoCount,
  assignmentCount,
}: {
  classroomId: string
  assignmentId: string
  orgLogin: string
  teamSlug: string | null
  staffCount: number
  unlinkedStaff: string[]
  repoCount: number
  assignmentCount: number
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run() {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      fd.set('assignmentId', assignmentId)

      const result = await grantStaffAccess(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }

      const { queued, synced, unlinked } = result.data
      const parts = [`${synced} staff member${synced === 1 ? '' : 's'} on the team`]
      if (queued > 0) {
        // Matches PER_MINUTE in the action. Ten a minute, so a 40-repository course
        // is about four minutes rather than the twenty an earlier pacing would have
        // taken.
        const minutes = Math.ceil(queued / 10)
        parts.push(
          `granting access to ${queued} repositor${queued === 1 ? 'y' : 'ies'}, about ${minutes} minute${minutes === 1 ? '' : 's'}`,
        )
      }
      if (unlinked.length > 0) {
        // Named, because this is the reason a TA still cannot see anything after the
        // button reports success.
        parts.push(`${unlinked.join(', ')} ${unlinked.length === 1 ? 'has' : 'have'} no linked GitHub account`)
      }
      setMessage(`${parts.join('; ')}.`)
      router.refresh()
    })
  }

  return (
    <section aria-label="Staff access">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle>Staff access</CardTitle>
              <CardDescription>
                Instructors and TAs get read and push access to every student
                repository <strong>in this classroom</strong> — across all
                assignments, not just this one — through a GitHub team in{' '}
                <span className="font-mono text-xs">{orgLogin}</span>. Being a TA in
                this app grants nothing on GitHub by itself — repositories are created
                with the student as their only collaborator, so without this a TA sees
                404 on all of them.
              </CardDescription>
            </div>
            <Badge tone={teamSlug ? 'success' : 'warning'} className="shrink-0">
              {teamSlug ? 'on' : 'not set up'}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat value={staffCount} label="Instructors and TAs" tone={teamSlug ? 'ok' : undefined} />
            <Stat
              value={repoCount}
              label={
                assignmentCount === 1
                  ? 'Repositories'
                  : `Repositories, ${assignmentCount} assignments`
              }
            />
            <Stat value={unlinkedStaff.length} label="Without GitHub" />
          </div>

          {teamSlug ? (
            <p className="text-sm text-muted">
              Team{' '}
              <a
                href={`https://github.com/orgs/${orgLogin}/teams/${teamSlug}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs underline underline-offset-2 hover:text-accent"
              >
                {teamSlug}
              </a>
              . New repositories are added as students accept, so this only needs
              running again when staff change.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Creating the team needs the organization-owner credential, not just the
              app — connect it on the classroom settings page first if this fails.
            </p>
          )}

          {unlinkedStaff.length > 0 ? (
            <p className="text-sm rounded-md bg-warning-subtle text-warning px-3 py-2">
              No linked GitHub account: {unlinkedStaff.join(', ')}. They must sign in
              to Code Classroom with GitHub before they can be added.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
              {error}
            </p>
          ) : null}
          {message ? <p className="text-sm text-muted">{message}</p> : null}
        </CardContent>

        <CardFooter className="flex justify-end">
          <Button type="button" variant="accent" disabled={pending} onClick={run}>
            {pending
              ? 'Working…'
              : teamSlug
                ? 'Re-sync staff and repositories'
                : 'Set up staff access'}
          </Button>
        </CardFooter>
      </Card>
    </section>
  )
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'ok' }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className={`text-2xl font-semibold tabular-nums ${tone === 'ok' ? 'text-success' : ''}`}>
        {value}
      </div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  )
}
