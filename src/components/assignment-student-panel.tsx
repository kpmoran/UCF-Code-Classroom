'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { acceptAssignment } from '@/lib/assignments/actions'

type RepoState = {
  status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED'
  fullName: string | null
  htmlUrl: string | null
  failureReason: string | null
  pendingInvitation: boolean
  feedbackPrNumber: number | null
}

/**
 * What a student sees for an individual assignment.
 *
 * Provisioning is asynchronous, so the page refreshes itself while a repository
 * is being created. Without that the student sees "setting up" and, having no
 * reason to reload, concludes it is broken.
 */
export function AssignmentStudentPanel({
  assignmentId,
  hasRosterEntry,
  githubLogin,
  orgLogin,
  repo,
}: {
  assignmentId: string
  hasRosterEntry: boolean
  githubLogin: string | null
  orgLogin: string
  repo: RepoState | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const inProgress = repo?.status === 'QUEUED' || repo?.status === 'PROVISIONING'

  useEffect(() => {
    if (!inProgress) return
    // Poll rather than stream: the wait is seconds to minutes, and a websocket
    // for this would not survive the serverless deployment option.
    const timer = setInterval(() => router.refresh(), 4000)
    return () => clearInterval(timer)
  }, [inProgress, router])

  function onAccept() {
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set('assignmentId', assignmentId)
      const result = await acceptAssignment(formData)
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }

  if (!hasRosterEntry) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Link your account first</CardTitle>
          <CardDescription>
            Before accepting assignments, use the invite link from your instructor to link
            your GitHub account to your name on the class roster.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!repo) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Accept this assignment</CardTitle>
          <CardDescription>
            A private repository will be created for you from the assignment template. You
            will be invited as a collaborator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
              {error}
            </p>
          ) : null}
          <Button variant="accent" size="lg" onClick={onAccept} disabled={pending}>
            {pending ? 'Accepting…' : 'Accept assignment'}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Your repository</CardTitle>
            <CardDescription>
              {repo.fullName ?? 'Being created…'}
            </CardDescription>
          </div>
          <StatusBadge status={repo.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {inProgress ? (
          <p className="text-muted">
            Setting up your repository. This usually takes a few seconds, but can take longer
            when a whole class accepts at once — GitHub limits how fast repositories can be
            created. This page updates itself.
          </p>
        ) : null}

        {repo.status === 'FAILED' ? (
          <div className="rounded-md bg-danger-subtle text-danger px-3 py-2 space-y-2">
            <p>{repo.failureReason ?? 'Something went wrong creating your repository.'}</p>
            <p className="text-xs">
              Your instructor can retry this. Let them know if it stays like this.
            </p>
          </div>
        ) : null}

        {repo.status === 'READY' && repo.htmlUrl ? (
          <>
            {repo.pendingInvitation ? (
              <div className="rounded-md bg-warning-subtle text-warning px-3 py-2">
                <p className="font-medium">Accept your GitHub invitation</p>
                <p className="mt-1 text-xs">
                  GitHub emailed you an invitation to this repository. You cannot push until
                  you accept it — check your email, or look for the notification on GitHub.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-md bg-foreground text-background px-4 h-10 text-sm font-medium hover:opacity-90"
              >
                Open repository
              </a>
              {repo.feedbackPrNumber ? (
                <a
                  href={`${repo.htmlUrl}/pull/${repo.feedbackPrNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center rounded-md border border-border-strong px-4 h-10 text-sm font-medium hover:bg-surface-subtle"
                >
                  Feedback pull request
                </a>
              ) : null}
            </div>

            <details className="text-xs text-muted">
              <summary className="cursor-pointer">How do I clone this?</summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-surface-subtle p-3 font-mono">
                git clone {repo.htmlUrl}.git
              </pre>
            </details>

            {/*
              * Two GitHub rules collide here, and getting either wrong sends a student
              * somewhere that cannot work.
              *
              * Repository-level boards were retired in August 2024, so a board is owned
              * by a user or an organization and linked to a repository afterwards. And
              * linking is ownership-bound: "You can only list projects that are owned by
              * the same user or organization that owns the repository." This repository
              * belongs to the classroom's organization, so a board on the student's own
              * account can never be linked to it — only the instructor can make one that
              * attaches here.
              *
              * An earlier version of this told students to create their own and link it,
              * which is exactly the dead end the rule above produces.
              */}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Planning your work?</summary>
              <p className="mt-2">
                GitHub project boards are owned by an account, not by a repository, and
                can only be linked to repositories owned by that same account. This
                repository belongs to{' '}
                <span className="font-mono">{orgLogin}</span>, so a board on your own
                account cannot be attached to it — ask your instructor if the course
                uses one.
              </p>
              {githubLogin ? (
                <p className="mt-2">
                  You can still keep{' '}
                  <a
                    href={`https://github.com/${githubLogin}?tab=projects`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    boards on your own account
                  </a>{' '}
                  for personal planning.
                </p>
              ) : null}
            </details>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: RepoState['status'] }) {
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
