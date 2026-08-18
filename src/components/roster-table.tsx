'use client'

import { useMemo, useState, useTransition } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import { setRosterEntryRemoved, unlinkRosterEntry } from '@/lib/roster/actions'

export type RosterRow = {
  id: string
  displayName: string
  sisUserId: string | null
  sisLoginId: string | null
  email: string | null
  section: string | null
  githubLogin: string | null
  claimedAt: string | null
  removed: boolean
}

export function RosterTable({
  classroomId,
  canManage,
  entries,
}: {
  classroomId: string
  canManage: boolean
  entries: RosterRow[]
}) {
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')
  const [status, setStatus] = useState<'all' | 'linked' | 'unlinked' | 'removed'>('all')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const sections = useMemo(
    () => Array.from(new Set(entries.map((e) => e.section).filter((s): s is string => !!s))).sort(),
    [entries],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (section && e.section !== section) return false
      if (status === 'linked' && (!e.githubLogin || e.removed)) return false
      if (status === 'unlinked' && (e.githubLogin || e.removed)) return false
      if (status === 'removed' && !e.removed) return false
      if (status !== 'removed' && status !== 'all' && e.removed) return false
      if (!q) return true
      return [e.displayName, e.sisUserId, e.sisLoginId, e.email, e.githubLogin]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [entries, query, section, status])

  function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) {
    setError(null)
    fd.set('classroomId', classroomId)
    startTransition(async () => {
      const result = await action(fd)
      if (!result.ok) setError(result.error ?? 'That action failed.')
    })
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-48">
          <Input
            aria-label="Search roster"
            placeholder="Search name, NID, email or GitHub login"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {sections.length > 0 ? (
          <Select
            aria-label="Filter by section"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            className="w-auto"
          >
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="w-auto"
        >
          <option value="all">All</option>
          <option value="linked">Linked</option>
          <option value="unlinked">Not linked</option>
          <option value="removed">Removed</option>
        </Select>
      </div>

      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border">
          <EmptyState
            title={entries.length === 0 ? 'No roster yet' : 'No matching students'}
            description={
              entries.length === 0
                ? 'Import a Canvas Gradebook CSV to create the roster.'
                : 'Try a different search or filter.'
            }
          />
        </div>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Student</Th>
                <Th>Section</Th>
                <Th>NID</Th>
                <Th>GitHub</Th>
                <Th>Status</Th>
                {canManage ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} className={e.removed ? 'opacity-60' : undefined}>
                  <Td>
                    <span className="font-medium">{e.displayName}</span>
                    {e.email ? (
                      <span className="block text-xs text-muted">{e.email}</span>
                    ) : null}
                  </Td>
                  <Td className="text-muted whitespace-nowrap">{e.section ?? '—'}</Td>
                  <Td className="font-mono text-xs text-muted">{e.sisLoginId ?? '—'}</Td>
                  <Td>
                    {e.githubLogin ? (
                      <a
                        href={`https://github.com/${e.githubLogin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs hover:underline"
                      >
                        @{e.githubLogin}
                      </a>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </Td>
                  <Td>
                    {e.removed ? (
                      <Badge tone="warning">Removed</Badge>
                    ) : e.githubLogin ? (
                      <Badge tone="success">Linked</Badge>
                    ) : (
                      <Badge tone="neutral">Not linked</Badge>
                    )}
                  </Td>
                  {canManage ? (
                    <Td className="text-right whitespace-nowrap">
                      <div className="inline-flex gap-1">
                        {e.githubLogin && !e.removed ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                              const fd = new FormData()
                              fd.set('entryId', e.id)
                              run(unlinkRosterEntry, fd)
                            }}
                            title="Detach this GitHub account so the entry can be claimed again"
                          >
                            Unlink
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            const fd = new FormData()
                            fd.set('entryId', e.id)
                            fd.set('removed', e.removed ? 'false' : 'true')
                            run(setRosterEntryRemoved, fd)
                          }}
                        >
                          {e.removed ? 'Restore' : 'Remove'}
                        </Button>
                      </div>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <p className="text-xs text-muted">
        Showing {filtered.length} of {entries.length}.
        {canManage
          ? ' Unlinking frees a roster entry to be claimed by a different GitHub account; it never touches repositories on GitHub.'
          : ''}
      </p>
    </section>
  )
}
