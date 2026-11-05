'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { resendMyOrgInvitation } from '@/lib/students/actions'

/**
 * Tells a student their organization invitation is waiting — or has run out — and
 * lets them send themselves a new one. Shown on the classroom page, because the
 * organization is what every assignment in it depends on.
 */
export function OrgInvitationNotice({
  classroomId,
  orgLogin,
  state,
}: {
  classroomId: string
  orgLogin: string
  state: 'pending' | 'expired'
}) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function resend() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('classroomId', classroomId)
      const result = await resendMyOrgInvitation(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage(
        result.data.resent === 0
          ? 'You are already a member — no invitation needed.'
          : 'A new invitation is on its way. GitHub will email it within a few minutes.',
      )
      router.refresh()
    })
  }

  return (
    <div role="status" className="rounded-md bg-warning-subtle text-warning px-4 py-3 text-sm">
      <p className="font-medium">
        {state === 'expired'
          ? `Your invitation to ${orgLogin} has expired`
          : `Accept your invitation to ${orgLogin} on GitHub`}
      </p>
      <p className="mt-1 text-xs">
        {state === 'expired'
          ? 'GitHub invitations last seven days. Request a new one below, then accept it from the email or from your GitHub notifications.'
          : 'GitHub emailed you an invitation to join the organization. Until you accept it you will not be able to push to your assignment repositories. Check your email, including spam, or your GitHub notifications.'}
      </p>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" disabled={pending} onClick={resend}>
          {pending ? 'Sending…' : 'Send me a new invitation'}
        </Button>
        {message ? <span className="text-xs">{message}</span> : null}
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  )
}
