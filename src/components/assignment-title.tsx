'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { FieldError, FieldHint, Input, Label } from '@/components/ui/input'
import { renameAssignment } from '@/lib/assignments/actions'

/**
 * The assignment's heading, which an instructor can rename in place.
 *
 * Edited where it is read rather than on a settings page: the title is the one
 * thing on this page everyone sees first, so the place to fix a typo in it is right
 * there. Everyone else gets a plain heading.
 */
export function AssignmentTitle({
  assignmentId,
  title,
  canRename,
}: {
  assignmentId: string
  title: string
  canRename: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!editing) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {canRename ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(title)
              setError(null)
              setEditing(true)
            }}
          >
            Rename
          </Button>
        ) : null}
      </div>
    )
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      fd.set('title', draft)
      const result = await renameAssignment(fd)
      if (!result.ok) {
        setError(result.fieldErrors?.title ?? result.error)
        return
      }
      setEditing(false)
      router.refresh()
    })
  }

  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <Label htmlFor="assignmentTitle" className="sr-only">
        Assignment title
      </Label>
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          id="assignmentTitle"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel()
          }}
          maxLength={200}
          autoFocus
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby="assignmentTitleHint"
          className="text-lg font-semibold max-w-xl"
        />
        <Button type="submit" size="sm" disabled={pending || draft.trim() === title}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={pending}>
          Cancel
        </Button>
      </div>
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <FieldHint id="assignmentTitleHint">
        Links to this assignment and its repositories keep their current names. The
        gradebook export will use the new title, so match it in Canvas.
      </FieldHint>
    </form>
  )
}
