'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { ButtonLink, Button } from '@/components/ui/button'
import { redeemFacultyInvite, type RedeemOutcome } from '@/lib/faculty/actions'

function AcceptButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" disabled={pending}>
      {pending ? 'Accepting…' : 'Accept invitation'}
    </Button>
  )
}

/**
 * Accept a faculty invitation.
 *
 * A button rather than something that happens on page load. Redeeming on a GET would
 * mean any link scanner that follows the URL — a mail client, a Slack unfurl, a
 * security proxy — silently consumes a single-use invitation before the person it was
 * sent to ever clicks it.
 */
export function AcceptFacultyInvite({ token }: { token: string }) {
  const [state, formAction] = useActionState(
    async (_prev: RedeemOutcome | null, formData: FormData) => redeemFacultyInvite(formData),
    null,
  )

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
          {state.alreadyFaculty
            ? 'You already had access — nothing changed.'
            : 'Done. You can now create classrooms.'}
        </p>
        <ButtonLink href="/classrooms/new" variant="accent">
          Create your first classroom
        </ButtonLink>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state && !state.ok ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {/*
           * One message for every reason. Saying which of revoked, expired, used up or
           * nonexistent applied would confirm to someone guessing tokens that a
           * particular one is real.
           */}
          This invitation cannot be used. It may have expired, been used already, or been
          withdrawn. Ask whoever sent it for a fresh link.
        </p>
      ) : null}
      <AcceptButton />
    </form>
  )
}
