'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Input } from '@/components/ui/input'
import { regenerateInviteLink } from '@/lib/classrooms/actions'
import type { ActionResult } from '@/lib/classrooms/schemas'

function RegenerateButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? 'Generating…' : 'Generate new link'}
    </Button>
  )
}

export function InviteLinkPanel({
  classroomId,
  joinUrl,
  useCount,
}: {
  classroomId: string
  joinUrl: string | null
  useCount: number
}) {
  const [copied, setCopied] = useState(false)
  const [state, formAction] = useActionState(
    async (_prev: ActionResult<never> | null, formData: FormData) =>
      regenerateInviteLink(formData),
    null,
  )

  async function copy() {
    if (!joinUrl) return
    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied; the input is selectable as a fallback.
      setCopied(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite link</CardTitle>
        <CardDescription>
          Share this with students. They sign in with GitHub, then pick their own name from
          the roster to link their account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {joinUrl ? (
          <>
            <div className="flex gap-2">
              {/* Labelled for screen readers: a bare readonly input announces
                  only its value, giving no clue what the URL is for. */}
              <Input
                readOnly
                aria-label="Invite link"
                value={joinUrl}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" variant="outline" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <FieldHint>
              Used {useCount} time{useCount === 1 ? '' : 's'}. Generating a new link
              immediately stops the old one working; students who already joined keep their
              access.
            </FieldHint>
          </>
        ) : (
          <p className="text-sm text-muted">
            No active invite link. Generate one to let students register.
          </p>
        )}

        {state && !state.ok ? (
          <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
            {state.error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-end">
        <form action={formAction}>
          <input type="hidden" name="classroomId" value={classroomId} />
          <RegenerateButton />
        </form>
      </CardFooter>
    </Card>
  )
}
