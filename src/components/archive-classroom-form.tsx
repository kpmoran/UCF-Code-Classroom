'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { FieldHint, Input, Label } from '@/components/ui/input'
import { setClassroomArchived } from '@/lib/classrooms/actions'
import type { ActionResult } from '@/lib/classrooms/schemas'

function ConfirmButton({ archived, enabled }: { archived: boolean; enabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={archived ? 'outline' : 'danger'}
      disabled={pending || !enabled}
    >
      {pending
        ? archived
          ? 'Restoring…'
          : 'Archiving…'
        : archived
          ? 'Restore classroom'
          : 'Archive classroom'}
    </Button>
  )
}

export function ArchiveForm({
  classroomId,
  slug,
  archived,
}: {
  classroomId: string
  slug: string
  archived: boolean
}) {
  const [typed, setTyped] = useState('')
  const [state, formAction] = useActionState(
    async (_prev: ActionResult<never> | null, formData: FormData) =>
      setClassroomArchived(formData),
    null,
  )

  // Restoring is harmless, so it needs no confirmation. Archiving hides the
  // classroom from every student, so it requires the slug typed exactly.
  const confirmed = archived || typed.trim() === slug

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="classroomId" value={classroomId} />
      <input type="hidden" name="archive" value={archived ? 'false' : 'true'} />
      <input type="hidden" name="confirmSlug" value={archived ? slug : typed} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {state.error}
        </p>
      ) : null}

      {!archived ? (
        <div>
          <Label htmlFor="confirm">
            Type <code className="font-mono">{slug}</code> to confirm
          </Label>
          <Input
            id="confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            placeholder={slug}
          />
          <FieldHint>
            No GitHub repositories are deleted or modified. This only affects
            UCF Code Classroom.
          </FieldHint>
        </div>
      ) : null}

      <ConfirmButton archived={archived} enabled={confirmed} />
    </form>
  )
}
