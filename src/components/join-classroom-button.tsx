'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { joinClassroomAsSiteAdmin } from '@/lib/classrooms/actions'

/**
 * Adds the acting site admin to a classroom as an instructor.
 *
 * Worth being explicit about what this is for. Site admins can reach any
 * classroom's configuration without joining, but not its roster or its grades —
 * running the server is not a standing licence to read another course's student
 * records. This is the way in when there is a real reason, and it leaves an entry in
 * that classroom's activity log naming who joined and when.
 *
 * So the label says "Join", not something softer. Someone clicking it should
 * understand they are adding themselves to a colleague's course, visibly.
 */
function Submit({ name }: { name: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="outline" disabled={pending}>
      {pending ? 'Joining…' : 'Join'}
      <span className="sr-only"> {name} as an instructor</span>
    </Button>
  )
}

export function JoinClassroomButton({
  classroomId,
  name,
}: {
  classroomId: string
  name: string
}) {
  const [state, formAction] = useActionState(
    async (_prev: { error: string } | null, formData: FormData) => {
      const result = await joinClassroomAsSiteAdmin(formData)
      return result.ok ? null : { error: result.error }
    },
    null,
  )

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="classroomId" value={classroomId} />
      <Submit name={name} />
      {state?.error ? (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      ) : null}
    </form>
  )
}
