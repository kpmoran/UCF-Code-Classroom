'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { FieldHint, Input, Label } from '@/components/ui/input'
import { addRosterEntry, type RosterActionResult } from '@/lib/roster/actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" disabled={pending}>
      {pending ? 'Adding…' : 'Add to roster'}
    </Button>
  )
}

/**
 * Add one student to the roster by hand.
 *
 * Deliberately adds a *roster entry* rather than a classroom member: the roster is
 * the list of people allowed to register, so a hand-added student then claims their
 * own entry with their own GitHub account through the invite link, exactly like
 * everyone imported from Canvas. Linking an account on their behalf would mean
 * guessing which GitHub login belongs to them, and a wrong guess hands one
 * student's repository to another.
 */
export function AddStudentForm({
  classroomId,
  slug,
  archived,
}: {
  classroomId: string
  slug: string
  archived: boolean
}) {
  /*
   * Controlled rather than uncontrolled, because React resets a form after its
   * action runs. Left uncontrolled, a rejected submission — a duplicate SIS id,
   * say — wiped all five fields and made the instructor retype everything to fix
   * one of them.
   */
  const empty = { displayName: '', sisLoginId: '', sisUserId: '', email: '', section: '' }
  const [fields, setFields] = useState(empty)
  const set = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))

  const [state, formAction] = useActionState(
    async (_prev: RosterActionResult<{ displayName: string }> | null, formData: FormData) => {
      const result = await addRosterEntry(formData)
      if (result.ok) setFields(empty)
      return result
    },
    null,
  )

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="classroomId" value={classroomId} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {state.error}
        </p>
      ) : null}

      {state?.ok ? (
        <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
          Added {state.data.displayName}.{' '}
          <Link href={`/classrooms/${slug}/roster`} className="underline">
            View the roster
          </Link>
        </p>
      ) : null}

      <div>
        <Label htmlFor="add-displayName">Name</Label>
        <Input
          id="add-displayName"
          name="displayName"
          value={fields.displayName}
          onChange={set('displayName')}
          required
          maxLength={200}
          placeholder="Alvarez, Ava"
          autoComplete="off"
          disabled={archived}
        />
        <FieldHint>
          Written the way Canvas writes it — <span className="font-mono">Last, First</span> — so
          the roster sorts alongside imported students.
        </FieldHint>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="add-sisLoginId">NID</Label>
          <Input
            id="add-sisLoginId"
            name="sisLoginId"
            value={fields.sisLoginId}
            onChange={set('sisLoginId')}
            placeholder="ab123456"
            autoComplete="off"
            disabled={archived}
          />
          <FieldHint>Used to name their repository. Optional.</FieldHint>
        </div>

        <div>
          <Label htmlFor="add-sisUserId">SIS user ID</Label>
          <Input
            id="add-sisUserId"
            name="sisUserId"
            value={fields.sisUserId}
            onChange={set('sisUserId')}
            placeholder="12345678"
            autoComplete="off"
            disabled={archived}
          />
          <FieldHint>
            Optional, but setting it lets a later Canvas import recognise this student instead
            of adding them twice.
          </FieldHint>
        </div>

        <div>
          <Label htmlFor="add-email">Email</Label>
          <Input
            id="add-email"
            name="email"
            value={fields.email}
            onChange={set('email')}
            type="email"
            placeholder="ava@knights.ucf.edu"
            autoComplete="off"
            disabled={archived}
          />
          <FieldHint>Optional. Preselects their name when they open the invite link.</FieldHint>
        </div>

        <div>
          <Label htmlFor="add-section">Section</Label>
          <Input
            id="add-section"
            name="section"
            value={fields.section}
            onChange={set('section')}
            placeholder="COP4331-0001"
            autoComplete="off"
            disabled={archived}
          />
          <FieldHint>Optional.</FieldHint>
        </div>
      </div>

      <SubmitButton />
    </form>
  )
}
