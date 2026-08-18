'use server'

import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/auth/dal'
import { claimRosterEntry } from '@/lib/roster/join'

export type JoinResult = { ok: false; error: string }

/**
 * Claim a roster entry as the signed-in student.
 *
 * On success this redirects, so the only value it ever returns is a failure —
 * which the form renders inline. The invite token is re-validated inside
 * `claimRosterEntry`; possessing an entry id is not authorization to claim it.
 */
export async function joinClassroom(formData: FormData): Promise<JoinResult> {
  const user = await requireUser()
  const token = String(formData.get('token') ?? '')
  const entryId = String(formData.get('entryId') ?? '')

  if (!token || !entryId) {
    return { ok: false, error: 'Choose your name from the list.' }
  }

  const outcome = await claimRosterEntry(token, user.id, entryId)
  if (!outcome.ok) return { ok: false, error: outcome.reason }

  redirect(`/classrooms/${outcome.classroomSlug}`)
}
