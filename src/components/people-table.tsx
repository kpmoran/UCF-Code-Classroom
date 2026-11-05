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
import { inviteStudentsToOrg } from '@/lib/students/actions'
import type { OrgState } from '@/lib/students/orgRules'

type MemberRow = {
  memberId: string
  userId: string
  role: 'INSTRUCTOR' | 'TA' | 'STUDENT'
  /** Where they stand with the organization; null for a student never invited. */
  orgState: OrgState | null
  orgFailure: string | null
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
  showOrg,
  members,
}: {
  classroomId: string
  canManage: boolean
  currentUserId: string
  instructorCount: number
  /** Whether the classroom makes students organization members, so the column means something. */
  showOrg: boolean
  members: MemberRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
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

  function inviteToOrg(member: MemberRow) {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      fd.set('classroomMemberId', member.memberId)
      const result = await inviteStudentsToOrg(fd)
      if (!result.ok) setError(result.error)
      else {
        setMessage(
          result.data.queued === 0
            ? `${member.name} does not need an invitation.`
            : `Inviting ${member.name}. GitHub will email them within a few minutes.`,
        )
        router.refresh()
      }
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
      {message ? (
        <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
          {message}
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
                {showOrg ? <Th>Organization</Th> : null}
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
                    {showOrg ? (
                      <Td>
                        <OrgCell
                          member={m}
                          canInvite={canManage && !pending}
                          onInvite={() => inviteToOrg(m)}
                        />
                      </Td>
                    ) : null}
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
              They lose access to this classroom in UCF Code Classroom, and their roster entry is
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

/**
 * A student's standing with the organization, and the way to put it right.
 *
 * "Invited" is the normal waiting state; "expired" is the one that needs a hand,
 * since GitHub never re-sends an invitation. Staff are shown nothing: their
 * membership is not this classroom's to manage.
 */
function OrgCell({
  member: m,
  canInvite,
  onInvite,
}: {
  member: MemberRow
  canInvite: boolean
  onInvite: () => void
}) {
  if (m.role !== 'STUDENT') return <span className="text-xs text-muted">—</span>

  const badge =
    m.orgState === 'active' ? (
      <Badge tone="success">member</Badge>
    ) : m.orgState === 'pending' ? (
      <Badge tone="info">invited</Badge>
    ) : m.orgState === 'expired' ? (
      <Badge tone="warning">invite expired</Badge>
    ) : m.orgState === 'failed' ? (
      <Badge tone="danger">failed</Badge>
    ) : m.orgState === 'removed' ? (
      <Badge tone="neutral">removed</Badge>
    ) : (
      <Badge tone="neutral">not invited</Badge>
    )

  const action =
    m.orgState === 'active' || m.orgState === 'removed'
      ? null
      : m.orgState === null || m.orgState === 'failed'
        ? 'Invite'
        : 'Resend'

  return (
    <div className="flex flex-col gap-1 items-start">
      {badge}
      {canInvite && action && m.githubLogin ? (
        <button
          type="button"
          className="text-xs text-accent hover:underline disabled:opacity-50"
          onClick={onInvite}
        >
          {action} invitation
        </button>
      ) : null}
      {m.orgFailure ? (
        <span className="text-xs text-danger max-w-xs">{m.orgFailure}</span>
      ) : null}
    </div>
  )
}
