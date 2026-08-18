'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/table'
import { createStudentTeam, moveStudentToTeam, provisionTeamNow } from '@/lib/teams/actions'

export type InstructorTeamView = {
  id: string
  name: string
  githubTeamSlug: string | null
  repo: {
    status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED'
    fullName: string | null
    htmlUrl: string | null
    failureReason: string | null
  } | null
  members: Array<{
    userId: string
    name: string
    githubLogin: string | null
    membershipState: string | null
  }>
}

export type UnassignedStudent = {
  userId: string
  name: string
  githubLogin: string | null
}

/**
 * Team management for staff.
 *
 * Moving a student is the escape hatch for everything team formation refuses to
 * let students do themselves — wrong team, a team that needs splitting, someone
 * who never joined one.
 */
export function InstructorTeamPanel({
  assignmentId,
  teams,
  unassigned,
}: {
  assignmentId: string
  teams: InstructorTeamView[]
  unassigned: UnassignedStudent[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [newTeamName, setNewTeamName] = useState('')
  const [pending, startTransition] = useTransition()

  const inFlight = teams.some(
    (t) => t.repo?.status === 'QUEUED' || t.repo?.status === 'PROVISIONING',
  )

  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [inFlight, router])

  function run(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    extra: Record<string, string>,
  ) {
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      for (const [k, v] of Object.entries(extra)) fd.set(k, v)
      const result = await action(fd)
      if (!result.ok) setError(result.error ?? 'That did not work.')
      else {
        setNewTeamName('')
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>
            {teams.length} team{teams.length === 1 ? '' : 's'} ·{' '}
            {unassigned.length} student{unassigned.length === 1 ? '' : 's'} not on a team
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              aria-label="New team name"
              placeholder="Create a team…"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              maxLength={60}
            />
            <Button
              variant="outline"
              disabled={pending || newTeamName.trim().length < 2}
              onClick={() => run(createStudentTeam, { name: newTeamName })}
            >
              Create
            </Button>
          </div>

          {teams.length === 0 ? (
            <EmptyState
              title="No teams yet"
              description="Students can form their own, or create teams here and assign members."
            />
          ) : (
            <ul className="space-y-3">
              {teams.map((t) => (
                <li key={t.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-medium">{t.name}</p>
                      {t.repo?.fullName ? (
                        <a
                          href={t.repo.htmlUrl ?? '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-muted hover:underline"
                        >
                          {t.repo.fullName}
                        </a>
                      ) : (
                        <p className="text-xs text-muted">no repository yet</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {t.repo ? <StatusBadge status={t.repo.status} /> : null}
                      {!t.repo || t.repo.status === 'FAILED' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending || t.members.length === 0}
                          onClick={() => run(provisionTeamNow, { teamId: t.id })}
                        >
                          {t.repo?.status === 'FAILED' ? 'Retry' : 'Create repository'}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {t.repo?.failureReason ? (
                    <p className="text-xs text-danger">{t.repo.failureReason}</p>
                  ) : null}

                  {t.members.length === 0 ? (
                    <p className="text-xs text-muted">No members.</p>
                  ) : (
                    <ul className="space-y-1">
                      {t.members.map((m) => (
                        <li
                          key={m.userId}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="truncate">{m.name}</span>
                            {m.githubLogin ? (
                              <span className="font-mono text-xs text-muted">
                                @{m.githubLogin}
                              </span>
                            ) : (
                              <Badge tone="warning">no GitHub</Badge>
                            )}
                            {m.membershipState === 'pending' ? (
                              <Badge tone="warning">invite pending</Badge>
                            ) : null}
                          </span>
                          <Select
                            aria-label={`Move ${m.name}`}
                            value={t.id}
                            disabled={pending}
                            onChange={(e) =>
                              run(moveStudentToTeam, {
                                studentUserId: m.userId,
                                targetTeamId: e.target.value,
                              })
                            }
                            className="w-auto h-8 text-xs"
                          >
                            {teams.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.name}
                              </option>
                            ))}
                            <option value="">— remove from team —</option>
                          </Select>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {unassigned.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Not on a team</CardTitle>
            <CardDescription>
              These students have registered but have not joined a team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {unassigned.map((s) => (
                <li key={s.userId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{s.name}</span>
                    {s.githubLogin ? (
                      <span className="font-mono text-xs text-muted">@{s.githubLogin}</span>
                    ) : (
                      <Badge tone="warning">no GitHub</Badge>
                    )}
                  </span>
                  {teams.length > 0 ? (
                    <Select
                      aria-label={`Assign ${s.name} to a team`}
                      defaultValue=""
                      disabled={pending}
                      onChange={(e) => {
                        if (!e.target.value) return
                        run(moveStudentToTeam, {
                          studentUserId: s.userId,
                          targetTeamId: e.target.value,
                        })
                      }}
                      className="w-auto h-8 text-xs"
                    >
                      <option value="">Assign to…</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-xs text-muted">create a team first</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function StatusBadge({ status }: { status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED' }) {
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
