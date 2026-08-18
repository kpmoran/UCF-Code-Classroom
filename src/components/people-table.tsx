'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select } from '@/components/ui/input'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import { ROLE_LABEL } from '@/lib/auth/roles'
import { removeClassroomMember, setMemberRole } from '@/lib/members/actions'

type MemberRow = {
  userId: string
  role: 'INSTRUCTOR' | 'TA' | 'STUDENT'
  name: string
  githubLogin: string | null
  email: string | null
  joinedAt: string
  repoCount: number
  isYou: boolean
}

type RepoAction = 'KEEP' | 'ARCHIVE' | 'DELETE'

export function PeopleTable({
  classroomId,
  canManage,
  instructorCount,
  members,
}: {
  classroomId: string
  canManage: boolean
  currentUserId: string
  instructorCount: number
  members: MemberRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [removing, setRemoving] = useState<MemberRow | null>(null)
  const [repoAction, setRepoAction] = useState<RepoAction>('KEEP')
  const [dialogError, setDialogError] = useState<string | null>(null)

  function changeRole(userId: string, role: string) {
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      fd.set('userId', userId)
      fd.set('role', role)
      const result = await setMemberRole(fd)
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }

  function confirmRemoval(confirmValue: string) {
    if (!removing) return
    setDialogError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      fd.set('userId', removing.userId)
      fd.set('repoAction', repoAction)
      fd.set('confirm', confirmValue)

      const result = await removeClassroomMember(fd)
      if (!result.ok) {
        setDialogError(result.error)
        return
      }
      setRemoving(null)
      setRepoAction('KEEP')
      router.refresh()
    })
  }

  const removalLabel = removing?.githubLogin ?? removing?.name ?? ''

  return (
    <section className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {error}
        </p>
      ) : null}

      {members.length === 0 ? (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="Nobody has joined yet"
            description="Students appear here after they open the invite link and claim their roster entry."
          />
        </div>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>GitHub</Th>
                <Th>Role</Th>
                <Th>Repos</Th>
                {canManage ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                // The last instructor cannot be demoted or removed, so the
                // controls are disabled rather than failing after a click.
                const isLastInstructor = m.role === 'INSTRUCTOR' && instructorCount <= 1

                return (
                  <tr key={m.userId}>
                    <Td>
                      <span className="font-medium">{m.name}</span>
                      {m.isYou ? <Badge tone="info" className="ml-2">you</Badge> : null}
                      {m.email ? (
                        <span className="block text-xs text-muted">{m.email}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {m.githubLogin ? (
                        <a
                          href={`https://github.com/${m.githubLogin}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs hover:underline"
                        >
                          @{m.githubLogin}
                        </a>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      {canManage ? (
                        <Select
                          aria-label={`Role for ${m.name}`}
                          value={m.role}
                          disabled={pending || isLastInstructor}
                          onChange={(e) => changeRole(m.userId, e.target.value)}
                          className="w-auto h-8 text-xs"
                        >
                          <option value="STUDENT">Student</option>
                          <option value="TA">TA</option>
                          <option value="INSTRUCTOR">Instructor</option>
                        </Select>
                      ) : (
                        <Badge tone={m.role === 'STUDENT' ? 'neutral' : 'info'}>
                          {ROLE_LABEL[m.role]}
                        </Badge>
                      )}
                      {isLastInstructor ? (
                        <span className="block text-xs text-muted mt-1">
                          only instructor
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-sm text-muted">{m.repoCount}</Td>
                    {canManage ? (
                      <Td className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending || isLastInstructor}
                          onClick={() => {
                            setRepoAction('KEEP')
                            setDialogError(null)
                            setRemoving(m)
                          }}
                        >
                          Remove
                        </Button>
                      </Td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ''} from this classroom?`}
        confirmLabel="Remove"
        destructive
        busy={pending}
        error={dialogError}
        // Typing is required only for the irreversible option.
        confirmText={repoAction === 'DELETE' ? removalLabel : null}
        onCancel={() => {
          if (pending) return
          setRemoving(null)
          setDialogError(null)
        }}
        onConfirm={() => confirmRemoval(repoAction === 'DELETE' ? removalLabel : '')}
        description={
          <>
            <p>
              They lose access to this classroom in UCF-Code-Connect, and their roster entry is
              freed so it can be claimed again. Their roster record is kept.
            </p>
            {removing && removing.repoCount > 0 ? (
              <p className="mt-2">
                They have <strong>{removing.repoCount}</strong> assignment{' '}
                {removing.repoCount === 1 ? 'repository' : 'repositories'} in this classroom.
              </p>
            ) : null}
          </>
        }
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Their GitHub repositories</legend>
          {(
            [
              [
                'KEEP',
                'Revoke their access, keep the repositories',
                'Their work stays and you can still read it. Right for a student who dropped.',
              ],
              [
                'ARCHIVE',
                'Archive the repositories',
                'Made read-only on GitHub. Reversible.',
              ],
              [
                'DELETE',
                'Delete the repositories permanently',
                'Cannot be undone by GitHub or by this app.',
              ],
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
                name="repoAction"
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
    </section>
  )
}
