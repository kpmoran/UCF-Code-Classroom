'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import {
  bulkProvision,
  retryFailedRepos,
  setAssignmentPublished,
} from '@/lib/assignments/actions'
import { recheckInvitations } from '@/lib/invitations/actions'
import { removeFromAssignment } from '@/lib/members/actions'

type RepoAction = 'KEEP' | 'ARCHIVE' | 'DELETE'

type RepoRow = {
  id: string
  status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED'
  fullName: string | null
  htmlUrl: string | null
  failureReason: string | null
  pendingInvitation: boolean
  feedbackPrNumber: number | null
  projectUrl: string | null
  who: string
  githubLogin: string | null
  acceptedAt: string
  lastPushedAt: string | null
  submission: {
    /** Commit captured at the deadline. '' means nothing was committed by then; null means not captured yet. */
    sha: string | null
    late: boolean
    locked: boolean
    extended: boolean
    deadline: string | null
  }
  autograde: {
    score: number | null
    maxScore: number | null
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
    hasDiscrepancies: boolean
  } | null
}

export function AssignmentStaffPanel({
  assignmentId,
  assignmentType,
  published,
  rosterClaimed,
  withoutRepo,
  estimatedDuration,
  budget,
  repos,
}: {
  assignmentId: string
  assignmentType: 'INDIVIDUAL' | 'GROUP'
  published: boolean
  classroomSlug: string
  rosterClaimed: number
  withoutRepo: number
  estimatedDuration: string
  budget: {
    minuteTokens: number
    perMinute: number
    hourTokens: number
    perHour: number
    isBlocked: boolean
  }
  repos: RepoRow[]
}) {
  const router = useRouter()
  const pendingInvitations = repos.filter(
    (r) => r.pendingInvitation && r.status === 'READY',
  ).length
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [removing, setRemoving] = useState<RepoRow | null>(null)
  const [repoAction, setRepoAction] = useState<RepoAction>('KEEP')
  const [dialogError, setDialogError] = useState<string | null>(null)

  const removingRepoName = removing?.fullName?.split('/')[1] ?? null

  function confirmRemoval() {
    if (!removing) return
    setDialogError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentRepoId', removing.id)
      fd.set('repoAction', repoAction)
      if (repoAction === 'DELETE' && removingRepoName) fd.set('confirm', removingRepoName)

      const result = await removeFromAssignment(fd)
      if (!result.ok) {
        setDialogError(result.error)
        return
      }
      setRemoving(null)
      setRepoAction('KEEP')
      router.refresh()
    })
  }

  const counts = useMemo(() => {
    const c = { READY: 0, QUEUED: 0, PROVISIONING: 0, FAILED: 0 }
    for (const r of repos) c[r.status] += 1
    return c
  }, [repos])

  const inFlight = counts.QUEUED + counts.PROVISIONING

  useEffect(() => {
    if (inFlight === 0) return
    // Keep the table honest while the worker grinds through the queue.
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [inFlight, router])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter((r) =>
      [r.who, r.githubLogin, r.fullName].filter(Boolean).some((v) =>
        String(v).toLowerCase().includes(q),
      ),
    )
  }, [repos, query])

  function run(action: (fd: FormData) => Promise<unknown>, extra?: Record<string, string>) {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v)

      const result = (await action(fd)) as
        | { ok: true; data?: unknown }
        | { ok: false; error: string }

      if (!result.ok) {
        setError(result.error)
        return
      }

      const data = result.data as
        | { queued?: number; skipped?: number; eta?: string; retried?: number }
        | undefined

      if (data?.queued !== undefined) {
        setMessage(
          data.queued === 0
            ? 'Every registered student already has a repository.'
            : `Queued ${data.queued} repositor${data.queued === 1 ? 'y' : 'ies'}. Estimated ${data.eta}.`,
        )
      } else if (data?.retried !== undefined) {
        setMessage(
          data.retried === 0 ? 'Nothing to retry.' : `Re-queued ${data.retried} repositories.`,
        )
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
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

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Ready" value={counts.READY} tone="success" />
        <Stat label="In progress" value={inFlight} tone="info" />
        <Stat label="Failed" value={counts.FAILED} tone={counts.FAILED ? 'danger' : 'neutral'} />
        <Stat label="Registered students" value={rosterClaimed} tone="neutral" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provisioning</CardTitle>
          <CardDescription>
            {assignmentType === 'GROUP'
              ? 'Group repositories are created when teams are formed.'
              : withoutRepo > 0
                ? `${withoutRepo} registered student${withoutRepo === 1 ? '' : 's'} ${
                    withoutRepo === 1 ? 'does' : 'do'
                  } not have a repository yet.`
                : 'Every registered student has a repository.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {assignmentType === 'INDIVIDUAL' ? (
              <Button
                variant="accent"
                disabled={pending || withoutRepo === 0}
                onClick={() => run(bulkProvision)}
              >
                {pending ? 'Queueing…' : `Create ${withoutRepo} repositor${withoutRepo === 1 ? 'y' : 'ies'} now`}
              </Button>
            ) : null}

            {counts.FAILED > 0 ? (
              <Button variant="outline" disabled={pending} onClick={() => run(retryFailedRepos)}>
                Retry {counts.FAILED} failed
              </Button>
            ) : null}

            {/*
              * Only when something is outstanding. Accepting an invitation happens on
              * GitHub and notifies this app of nothing, so a row can claim an
              * invitation is pending long after it was taken up — this asks.
              */}
            {pendingInvitations > 0 ? (
              <Button variant="outline" disabled={pending} onClick={() => run(recheckInvitations)}>
                Re-check {pendingInvitations} invitation{pendingInvitations === 1 ? '' : 's'}
              </Button>
            ) : null}

            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(setAssignmentPublished, { publish: published ? 'false' : 'true' })
              }
            >
              {published ? 'Unpublish' : 'Publish'}
            </Button>
          </div>

          {withoutRepo > 0 && assignmentType === 'INDIVIDUAL' ? (
            <p className="text-xs text-muted">
              Estimated {estimatedDuration}. GitHub limits how fast repositories can be
              created, so this is paced deliberately and continues in the background — you can
              leave this page.
            </p>
          ) : null}

          {/* Budget shown plainly, so a slow provision reads as pacing rather than a fault. */}
          <div className="rounded-md border border-border bg-surface-subtle px-3 py-2 text-xs text-muted">
            GitHub request budget: {budget.minuteTokens}/{budget.perMinute} this minute ·{' '}
            {budget.hourTokens}/{budget.perHour} this hour
            {budget.isBlocked ? (
              <span className="text-warning"> · paused by GitHub, will resume automatically</span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">Repositories</h2>
          <div className="w-64">
            <Input
              aria-label="Search repositories"
              placeholder="Search student or repository"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-lg border border-border">
            <EmptyState
              title={repos.length === 0 ? 'No repositories yet' : 'No matches'}
              description={
                repos.length === 0
                  ? assignmentType === 'GROUP'
                    ? 'Repositories appear once students form teams.'
                    : 'Students can accept the assignment themselves, or create all repositories now.'
                  : 'Try a different search.'
              }
            />
          </div>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{assignmentType === 'GROUP' ? 'Team' : 'Student'}</Th>
                  <Th>Repository</Th>
                  <Th>Status</Th>
                  <Th>Score</Th>
                  <Th>Last push</Th>
                  <Th>Submitted</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <span className="font-medium">{r.who}</span>
                      {r.githubLogin ? (
                        <span className="block text-xs text-muted font-mono">
                          @{r.githubLogin}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {r.htmlUrl ? (
                        <a
                          href={r.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs hover:underline"
                        >
                          {r.fullName}
                        </a>
                      ) : (
                        <span className="text-xs text-muted">{r.fullName ?? '—'}</span>
                      )}
                      {r.feedbackPrNumber && r.htmlUrl ? (
                        <a
                          href={`${r.htmlUrl}/pull/${r.feedbackPrNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-xs text-accent hover:underline"
                        >
                          Feedback #{r.feedbackPrNumber}
                        </a>
                      ) : null}
                      {r.projectUrl ? (
                        <a
                          href={r.projectUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-xs text-accent hover:underline"
                        >
                          Project board
                        </a>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1 items-start">
                        <StatusBadge status={r.status} />
                        {r.pendingInvitation && r.status === 'READY' ? (
                          <Badge tone="warning">Invite not accepted</Badge>
                        ) : null}
                        {r.failureReason ? (
                          <span className="text-xs text-danger max-w-xs">{r.failureReason}</span>
                        ) : null}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <ScoreCell autograde={r.autograde} />
                    </Td>
                    <Td className="text-xs text-muted whitespace-nowrap">
                      {r.lastPushedAt
                        ? new Date(r.lastPushedAt).toLocaleString('en-US', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : 'no pushes'}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <SubmissionCell submission={r.submission} htmlUrl={r.htmlUrl} />
                    </Td>
                    <Td className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setRepoAction('KEEP')
                          setDialogError(null)
                          setRemoving(r)
                        }}
                      >
                        Remove
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.who ?? ''} from this assignment?`}
        confirmLabel="Remove"
        destructive
        busy={pending}
        error={dialogError}
        confirmText={repoAction === 'DELETE' ? removingRepoName : null}
        onCancel={() => {
          if (pending) return
          setRemoving(null)
          setDialogError(null)
        }}
        onConfirm={confirmRemoval}
        description={
          <>
            <p>
              Their access to this repository is revoked. Other assignments and their
              classroom membership are unaffected.
            </p>
            {removing?.fullName ? (
              <p className="mt-2 font-mono text-xs">{removing.fullName}</p>
            ) : (
              <p className="mt-2">No repository was created on GitHub for them yet.</p>
            )}
          </>
        }
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">The repository</legend>
          {(
            [
              ['KEEP', 'Revoke access, keep the repository', 'Their work stays and you can still read it.'],
              ['ARCHIVE', 'Archive the repository', 'Read-only on GitHub. Reversible.'],
              ['DELETE', 'Delete the repository permanently', 'Cannot be undone.'],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={`flex gap-2 items-start rounded-md border px-3 py-2 cursor-pointer text-sm ${
                repoAction === value ? 'border-accent bg-surface-subtle' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name="assignmentRepoAction"
                value={value}
                checked={repoAction === value}
                onChange={() => {
                  setRepoAction(value)
                  setDialogError(null)
                }}
                className="mt-0.5"
              />
              <span>
                <span className={value === 'DELETE' ? 'font-medium text-danger' : 'font-medium'}>
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
  tone: 'success' | 'info' | 'danger' | 'neutral'
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'info'
        ? 'text-info'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-foreground'
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: RepoRow['status'] }) {
  switch (status) {
    case 'READY':
      return <Badge tone="success">Ready</Badge>
    case 'FAILED':
      return <Badge tone="danger">Failed</Badge>
    case 'PROVISIONING':
      return <Badge tone="info">Creating…</Badge>
    default:
      return <Badge tone="neutral">Queued</Badge>
  }
}

/**
 * Autograde score for one repository.
 *
 * A discrepancy badge is shown alongside the score rather than instead of it: the
 * score is still the best available number, but a modified workflow or manifest is
 * something the instructor must know about before recording a grade.
 */
/**
 * What this student actually submitted by their deadline.
 *
 * The sweep has recorded a commit for every repository past its deadline since
 * deadlines existed, and until now nothing displayed it — the data was captured
 * for grading and then only readable in the database.
 *
 * Three states worth distinguishing, because they look identical if you collapse
 * them: no capture yet (the deadline has not passed, or the sweep has not run),
 * a captured commit, and a capture that found nothing — the sweep records the
 * empty string for a repository with no commit by the deadline, which means
 * "graded as not submitted", not "we did not look".
 */
function SubmissionCell({
  submission,
  htmlUrl,
}: {
  submission: RepoRow['submission']
  htmlUrl: string | null
}) {
  const { sha, late, locked, extended } = submission

  if (sha === null) {
    return (
      <span className="text-xs text-muted">
        {submission.deadline ? 'not yet' : '—'}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1.5">
      {sha === '' ? (
        <Badge tone="danger">nothing by deadline</Badge>
      ) : htmlUrl ? (
        // Links to the exact commit that would be graded, so an instructor can read
        // the submitted state without working out which commit that was.
        <a
          href={`${htmlUrl}/commit/${sha}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline underline-offset-2 hover:text-accent"
          title={`Commit captured at the deadline: ${sha}`}
        >
          {sha.slice(0, 7)}
        </a>
      ) : (
        <span className="font-mono text-xs">{sha.slice(0, 7)}</span>
      )}

      {/* Late is judged on the last push, so it stays true after the fact rather than
          being recomputed from the current time. */}
      {late ? <Badge tone="warning">late</Badge> : null}
      {locked ? <Badge tone="neutral">locked</Badge> : null}
      {extended ? <Badge tone="info">extended</Badge> : null}
    </span>
  )
}

function ScoreCell({ autograde }: { autograde: RepoRow['autograde'] }) {
  if (!autograde) return <span className="text-xs text-muted">—</span>

  if (autograde.status === 'FAILED') {
    return <Badge tone="danger">no results</Badge>
  }
  if (autograde.status !== 'COMPLETED') {
    return <Badge tone="info">running</Badge>
  }

  const score = autograde.score ?? 0
  const max = autograde.maxScore ?? 0
  const ratio = max > 0 ? score / max : 0
  const tone = ratio >= 0.8 ? 'success' : ratio >= 0.5 ? 'warning' : 'danger'

  return (
    <span className="flex items-center gap-1.5">
      <Badge tone={tone}>
        {score}/{max}
      </Badge>
      {autograde.hasDiscrepancies ? (
        <Badge tone="warning" title="The workflow or manifest may have been modified">
          check
        </Badge>
      ) : null}
    </span>
  )
}
