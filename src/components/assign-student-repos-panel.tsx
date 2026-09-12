'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/table'
import { assignStudentRepo } from '@/lib/assignments/actions'

export type AssignableStudent = {
  userId: string
  name: string
  githubLogin: string | null
  repo: {
    status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED'
    fullName: string | null
    htmlUrl: string | null
    failureReason: string | null
  } | null
}

/**
 * Assign each student a repository that already exists.
 *
 * Only rendered for an individual assignment whose `repoSource` is EXISTING, where
 * it is the sole way a student gets a repository — they cannot accept their way into
 * one, because which repository they belong in is not something they can know.
 *
 * Deliberately permits the same repository for several students: the count next to a
 * shared one is there so that is visible while assigning rather than discovered later
 * when two students turn out to have identical grades.
 */
export function AssignStudentReposPanel({
  assignmentId,
  orgLogin,
  students,
}: {
  assignmentId: string
  orgLogin: string
  students: AssignableStudent[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [pending, startTransition] = useTransition()

  const inFlight = students.some(
    (s) => s.repo?.status === 'QUEUED' || s.repo?.status === 'PROVISIONING',
  )

  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [inFlight, router])

  // How many students share each repository, so a shared one can say so.
  const shareCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of students) {
      if (!s.repo?.fullName) continue
      counts.set(s.repo.fullName, (counts.get(s.repo.fullName) ?? 0) + 1)
    }
    return counts
  }, [students])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return students
    return students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.githubLogin?.toLowerCase().includes(q) ?? false) ||
        (s.repo?.fullName?.toLowerCase().includes(q) ?? false),
    )
  }, [students, query])

  const assigned = students.filter((s) => s.repo).length

  function assign(studentUserId: string) {
    const repo = inputs[studentUserId] ?? ''
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      fd.set('studentUserId', studentUserId)
      fd.set('repo', repo)

      const result = await assignStudentRepo(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data.shared > 0) {
        setNotice(
          `Assigned. This repository is now shared with ${result.data.shared} other ` +
            `student${result.data.shared === 1 ? '' : 's'}.`,
        )
      }
      setInputs((prev) => ({ ...prev, [studentUserId]: '' }))
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assign repositories</CardTitle>
        <CardDescription>
          {assigned} of {students.length} student{students.length === 1 ? '' : 's'} assigned ·
          repositories must already exist in {orgLogin} · more than one student may share one
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="text-sm rounded-md bg-surface-subtle text-muted px-3 py-2">{notice}</p>
        ) : null}

        {students.length > 6 ? (
          <Input
            aria-label="Search students"
            placeholder="Search by name, GitHub login or repository…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}

        {students.length === 0 ? (
          <EmptyState
            title="No students yet"
            description="Students appear here once they have claimed their roster entry."
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matches" description="Nothing matched that search." />
        ) : (
          <ul className="space-y-3">
            {filtered.map((s) => {
              const shared = s.repo?.fullName ? (shareCounts.get(s.repo.fullName) ?? 0) : 0
              return (
                <li key={s.userId} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-medium flex items-center gap-2">
                        <span className="truncate">{s.name}</span>
                        {s.githubLogin ? (
                          <span className="font-mono text-xs text-muted">@{s.githubLogin}</span>
                        ) : (
                          <Badge tone="warning">no GitHub</Badge>
                        )}
                      </p>
                      {s.repo?.fullName ? (
                        <p className="flex items-center gap-2">
                          <a
                            href={s.repo.htmlUrl ?? '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs text-muted hover:underline"
                          >
                            {s.repo.fullName}
                          </a>
                          {shared > 1 ? (
                            <Badge tone="info">shared with {shared - 1}</Badge>
                          ) : null}
                        </p>
                      ) : (
                        <p className="text-xs text-muted">no repository assigned</p>
                      )}
                    </div>
                    {s.repo ? <StatusBadge status={s.repo.status} /> : null}
                  </div>

                  {s.repo?.failureReason ? (
                    <p className="text-xs text-danger">{s.repo.failureReason}</p>
                  ) : null}

                  <div className="flex gap-2">
                    <Input
                      aria-label={`Repository for ${s.name}`}
                      placeholder={s.repo?.fullName ?? `${orgLogin}/repo-name`}
                      value={inputs[s.userId] ?? ''}
                      onChange={(e) =>
                        setInputs((prev) => ({ ...prev, [s.userId]: e.target.value }))
                      }
                      className="h-8 text-xs font-mono"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending || (inputs[s.userId] ?? '').trim().length < 2}
                      onClick={() => assign(s.userId)}
                    >
                      {s.repo?.fullName ? 'Reassign' : 'Assign'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED' }) {
  switch (status) {
    case 'READY':
      return <Badge tone="success">Ready</Badge>
    case 'FAILED':
      return <Badge tone="danger">Failed</Badge>
    case 'PROVISIONING':
      // Nothing is being created; what is in flight is access and the workflow.
      return <Badge tone="info">Linking…</Badge>
    default:
      return <Badge tone="neutral">Queued</Badge>
  }
}
