'use client'

import Link from 'next/link'

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
  const [state, formAction] = useActionState(
    async (_prev: ActionResult<never> | null, formData: FormData) =>
      regenerateInviteLink(formData),
    null,
  )
  const { copied, copy } = useCopy(joinUrl)

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

/** Clipboard write with a brief confirmation, shared by both views below. */
function useCopy(value: string | null) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied; the input is selectable as a fallback.
      setCopied(false)
    }
  }

  return { copied, copy }
}

/**
 * The invite link, compact, for the top of the classroom page.
 *
 * Sharing the link is the first thing an instructor does with a new classroom and a
 * recurring thing afterwards — every late add needs it — so it belongs where they
 * land rather than two clicks away in settings. This is deliberately read-and-copy
 * only: regenerating it invalidates the link students may already be holding, which
 * is not a decision to put one stray click away from a page people open constantly.
 * That stays in settings, with its warning.
 */
export function InviteLinkBar({
  joinUrl,
  useCount,
  settingsHref,
}: {
  joinUrl: string | null
  useCount: number
  settingsHref: string
}) {
  const { copied, copy } = useCopy(joinUrl)

  if (!joinUrl) {
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
        No active invite link, so students cannot register.{' '}
        <Link href={settingsHref} className="underline">
          Generate one in settings
        </Link>
        .
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium shrink-0">Invite link</span>
        <Input
          readOnly
          aria-label="Invite link"
          value={joinUrl}
          className="font-mono text-xs flex-1 min-w-56"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Students sign in with GitHub and pick their own name from the roster. Used{' '}
        {useCount} time{useCount === 1 ? '' : 's'}.
      </p>
    </div>
  )
}
