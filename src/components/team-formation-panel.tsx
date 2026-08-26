'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { SubmissionSummaryPanel } from '@/components/submission-summary'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { SubmissionSummary } from '@/lib/deadlines/summary'
import { FieldHint, Input, Label } from '@/components/ui/input'
import { createStudentTeam, joinTeam, leaveTeam } from '@/lib/teams/actions'

export type TeamMemberView = {
  userId: string
  name: string
  githubLogin: string | null
  isYou: boolean
  /** GitHub team membership: 'active', 'pending', or null before provisioning. */
  membershipState: string | null
}

export type TeamView = {
  id: string
  name: string
  members: TeamMemberView[]
  repo: {
    status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED'
    fullName: string | null
    htmlUrl: string | null
    failureReason: string | null
    feedbackPrNumber: number | null
  } | null
  full: boolean
}

/**
 * Team formation for a group assignment, from the student's side.
 *
 * The pending-versus-active distinction is given prominence because it is the
 * single most confusing state in the whole flow: GitHub emails an invitation, and
 * until the student accepts it they are on the team in this app but **cannot push**
 * to the repository. Left unexplained this reliably reads as a broken tool.
 */
export function TeamFormationPanel({
  assignmentId,
  teams,
  yourTeamId,
  yourSubmission,
  constraintsText,
  canCreate,
  hasRosterClaim,
}: {
  assignmentId: string
  teams: TeamView[]
  yourTeamId: string | null
  /** Only the viewer's own team: what the rest of the class submitted is not theirs to see. */
  yourSubmission: SubmissionSummary | null
  constraintsText: string
  canCreate: boolean
  hasRosterClaim: boolean
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const yourTeam = teams.find((t) => t.id === yourTeamId) ?? null
  const inProgress =
    yourTeam?.repo?.status === 'QUEUED' || yourTeam?.repo?.status === 'PROVISIONING'

  useEffect(() => {
    if (!inProgress) return
    const timer = setInterval(() => router.refresh(), 4000)
    return () => clearInterval(timer)
  }, [inProgress, router])

  function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, extra: Record<string, string>) {
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      for (const [k, v] of Object.entries(extra)) fd.set(k, v)
      const result = await action(fd)
      if (!result.ok) setError(result.error ?? 'That did not work.')
      else {
        setName('')
        router.refresh()
      }
    })
  }

  if (!hasRosterClaim) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Link your account first</CardTitle>
          <CardDescription>
            Before joining a team, use the invite link from your instructor to link your GitHub
            account to your name on the class roster.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      {yourTeam ? (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Your team: {yourTeam.name}</CardTitle>
                <CardDescription>
                  {yourTeam.members.length} member{yourTeam.members.length === 1 ? '' : 's'}
                </CardDescription>
              </div>
              {yourTeam.repo ? <RepoStatusBadge status={yourTeam.repo.status} /> : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="space-y-1">
              {yourTeam.members.map((m) => (
                <li key={m.userId} className="flex items-center gap-2">
                  <span>{m.name}</span>
                  {m.githubLogin ? (
                    <span className="font-mono text-xs text-muted">@{m.githubLogin}</span>
                  ) : (
                    <Badge tone="warning">no GitHub account</Badge>
                  )}
                  {m.isYou ? <Badge tone="info">you</Badge> : null}
                  {m.membershipState === 'pending' ? (
                    <Badge tone="warning">invite pending</Badge>
                  ) : null}
                </li>
              ))}
            </ul>

            {inProgress ? (
              <p className="text-muted">
                Setting up your team’s repository. This page updates itself.
              </p>
            ) : null}

            {yourTeam.repo?.status === 'FAILED' ? (
              <p className="rounded-md bg-danger-subtle text-danger px-3 py-2">
                {yourTeam.repo.failureReason ?? 'Something went wrong creating the repository.'}
              </p>
            ) : null}

            {yourTeam.repo?.status === 'READY' && yourTeam.repo.htmlUrl ? (
              <>
                {yourTeam.members.some(
                  (m) => m.isYou && m.membershipState === 'pending',
                ) ? (
                  <div className="rounded-md bg-warning-subtle text-warning px-3 py-2">
                    <p className="font-medium">Accept your GitHub team invitation</p>
                    <p className="mt-1 text-xs">
                      GitHub emailed you an invitation to the{' '}
                      <span className="font-mono">{yourTeam.name}</span> team. You will not be
                      able to push until you accept it — check your email, or your GitHub
                      notifications.
                    </p>
                  </div>
                ) : null}

                {yourSubmission ? (
                  <SubmissionSummaryPanel
                    submission={yourSubmission}
                    htmlUrl={yourTeam.repo.htmlUrl}
                  />
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <a
                    href={yourTeam.repo.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-md bg-foreground text-background px-4 h-10 text-sm font-medium hover:opacity-90"
                  >
                    Open repository
                  </a>
                  {yourTeam.repo.feedbackPrNumber ? (
                    <a
                      href={`${yourTeam.repo.htmlUrl}/pull/${yourTeam.repo.feedbackPrNumber}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-md border border-border-strong px-4 h-10 text-sm font-medium hover:bg-surface-subtle"
                    >
                      Feedback pull request
                    </a>
                  ) : null}
                </div>
              </>
            ) : null}

            {!yourTeam.repo || yourTeam.repo.status !== 'READY' ? (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(leaveTeam, {})}
                >
                  Leave team
                </Button>
                <FieldHint>
                  You can leave until the repository exists. After that, ask your instructor to
                  move you.
                </FieldHint>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Join or create a team</CardTitle>
            <CardDescription>{constraintsText}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {canCreate ? (
              <div>
                <Label htmlFor="teamName">New team name</Label>
                <div className="flex gap-2">
                  <Input
                    id="teamName"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    placeholder="The Knights"
                  />
                  <Button
                    variant="accent"
                    disabled={pending || name.trim().length < 2}
                    onClick={() => run(createStudentTeam, { name })}
                  >
                    {pending ? 'Creating…' : 'Create'}
                  </Button>
                </div>
                <FieldHint>
                  Becomes part of your repository name, so keep it short and simple.
                </FieldHint>
              </div>
            ) : (
              <p className="text-sm text-muted">
                Your instructor assigns teams for this assignment.
              </p>
            )}

            {teams.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Existing teams</p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {teams.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t.name}</p>
                        <p className="text-xs text-muted truncate">
                          {t.members.length === 0
                            ? 'no members yet'
                            : t.members.map((m) => m.name).join(', ')}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || t.full}
                        onClick={() => run(joinTeam, { teamId: t.id })}
                      >
                        {t.full ? 'Full' : 'Join'}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted">
                No teams yet.{canCreate ? ' Be the first to create one.' : ''}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RepoStatusBadge({ status }: { status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED' }) {
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
