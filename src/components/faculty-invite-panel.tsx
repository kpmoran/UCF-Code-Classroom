'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Input, Label, Select } from '@/components/ui/input'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import {
  createFacultyInvite,
  revokeFacultyInvite,
  setFacultyStatus,
  type FacultyActionResult,
} from '@/lib/faculty/actions'

export type InviteRow = {
  id: string
  note: string | null
  maxUses: number
  used: number
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  /** Present only for the invite just created, so it can be copied once. */
  url?: string
}

export type FacultyRow = {
  id: string
  githubLogin: string | null
  name: string | null
  isSiteAdmin: boolean
  fromConfig: boolean
  classrooms: number
}

function SubmitButton({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" disabled={pending}>
      {pending ? busy : label}
    </Button>
  )
}

function RowSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending}>
      {pending ? '\u2026' : label}
    </Button>
  )
}

/**
 * A one-button form whose failure is reported in the row it belongs to.
 *
 * React requires a plain `<form action>` to return nothing, so passing these actions
 * directly would not typecheck — and the obvious fix, wrapping them to discard the
 * result, silently swallows messages worth reading, like refusing to let an admin
 * withdraw their own access.
 */
function RowAction({
  action,
  fields,
  label,
}: {
  action: (formData: FormData) => Promise<FacultyActionResult>
  fields: Record<string, string>
  label: string
}) {
  const [state, formAction] = useActionState(
    async (_prev: FacultyActionResult | null, formData: FormData) => action(formData),
    null,
  )
  return (
    <form action={formAction}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <RowSubmit label={label} />
      {state && !state.ok ? (
        <p role="alert" className="text-xs text-danger mt-1 text-right">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}

/**
 * Faculty access management, for site admins.
 *
 * Two halves, because they answer different questions: who can create classrooms
 * right now, and which invitations are outstanding. An invite that has been sent and
 * forgotten is the thing most likely to go wrong here, so the table shows uses and
 * expiry rather than hiding them behind a detail view.
 */
export function FacultyInvitePanel({
  invites,
  faculty,
  appUrl,
}: {
  invites: InviteRow[]
  faculty: FacultyRow[]
  appUrl: string
}) {
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [state, formAction] = useActionState(
    async (_prev: FacultyActionResult<{ token: string }> | null, formData: FormData) => {
      const result = await createFacultyInvite(formData)
      if (result.ok) {
        setCreated(`${appUrl.replace(/\/$/, '')}/faculty-invite/${result.data.token}`)
        setCopied(false)
      }
      return result
    },
    null,
  )

  async function copy() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invite a colleague</CardTitle>
          <CardDescription>
            Signing in with GitHub proves only that someone has a GitHub account, and every
            student has one — so it cannot decide who may create a classroom. An invitation
            is how someone joins the faculty side.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state && !state.ok ? (
            <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
              {state.error}
            </p>
          ) : null}

          {created ? (
            <div className="rounded-md bg-success-subtle text-success px-3 py-3 space-y-2">
              <p className="text-sm font-medium">Invitation created. Send them this link:</p>
              <div className="flex gap-2">
                <Input readOnly value={created} className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs">
                Shown once. It is not recoverable from this page afterwards — issue a new one
                if it goes missing, and revoke the old one below.
              </p>
            </div>
          ) : null}

          <form action={formAction} className="space-y-4">
            <div>
              <Label htmlFor="note">Who is it for?</Label>
              <Input
                id="note"
                name="note"
                maxLength={200}
                placeholder="Dr. Rivera, COP 3502"
                autoComplete="off"
              />
              <FieldHint>
                Only so you can tell your outstanding invitations apart later. Not shown to
                them.
              </FieldHint>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="maxUses">Uses</Label>
                <Select id="maxUses" name="maxUses" defaultValue="1">
                  <option value="1">1 — a single colleague</option>
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="25">25 — a workshop</option>
                </Select>
                <FieldHint>
                  One by default: a link meant for one person should not quietly work for
                  whoever they forward it to.
                </FieldHint>
              </div>

              <div>
                <Label htmlFor="expiresInDays">Expires in</Label>
                <Select id="expiresInDays" name="expiresInDays" defaultValue="14">
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="90">90 days</option>
                </Select>
                <FieldHint>
                  Always expires. A link that grants classroom-creation rights forever is a
                  credential nobody remembers issuing.
                </FieldHint>
              </div>
            </div>

            <SubmitButton label="Create invitation" busy="Creating…" />
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outstanding invitations</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {invites.length === 0 ? (
            <EmptyState
              title="No invitations yet"
              description="Create one above to let another instructor in."
            />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>For</Th>
                    <Th>Uses</Th>
                    <Th>Expires</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => {
                    const expired = i.expiresAt !== null && new Date(i.expiresAt) < new Date()
                    const exhausted = i.used >= i.maxUses
                    const dead = i.revokedAt !== null || expired || exhausted
                    return (
                      <tr key={i.id}>
                        <Td>{i.note ?? <span className="text-muted">—</span>}</Td>
                        <Td>
                          {i.used} / {i.maxUses}
                        </Td>
                        <Td className="whitespace-nowrap">
                          {i.expiresAt
                            ? new Date(i.expiresAt).toLocaleDateString('en-US', {
                                dateStyle: 'medium',
                              })
                            : 'never'}
                        </Td>
                        <Td>
                          {i.revokedAt ? (
                            <Badge tone="neutral">Revoked</Badge>
                          ) : expired ? (
                            <Badge tone="warning">Expired</Badge>
                          ) : exhausted ? (
                            <Badge tone="neutral">Used up</Badge>
                          ) : (
                            <Badge tone="success">Active</Badge>
                          )}
                        </Td>
                        <Td className="text-right">
                          {dead ? null : (
                            <RowAction
                              action={revokeFacultyInvite}
                              fields={{ inviteId: i.id }}
                              label="Revoke"
                            />
                          )}
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who can create classrooms</CardTitle>
          <CardDescription>
            Withdrawing access does not touch the classrooms someone already runs — they stay
            an instructor there. It only stops them starting new ones.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {faculty.length === 0 ? (
            <EmptyState title="Nobody yet" description="Only site admins can create classrooms." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th>Classrooms</Th>
                    <Th>Source</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {faculty.map((f) => (
                    <tr key={f.id}>
                      <Td>
                        <span className="font-medium">{f.name ?? '—'}</span>
                        {f.githubLogin ? (
                          <span className="block text-xs text-muted font-mono">
                            @{f.githubLogin}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{f.classrooms}</Td>
                      <Td>
                        {f.fromConfig ? (
                          <Badge tone="info">SITE_ADMIN_LOGINS</Badge>
                        ) : f.isSiteAdmin ? (
                          <Badge tone="info">Site admin</Badge>
                        ) : (
                          <Badge tone="neutral">Invited</Badge>
                        )}
                      </Td>
                      <Td className="text-right">
                        {f.fromConfig ? (
                          <span className="text-xs text-muted">set in configuration</span>
                        ) : (
                          <RowAction
                            action={setFacultyStatus}
                            fields={{ userId: f.id, grant: 'false' }}
                            label="Withdraw"
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
