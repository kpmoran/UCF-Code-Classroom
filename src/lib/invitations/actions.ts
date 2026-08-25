'use server'

import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { reconcileInvitations } from '@/lib/invitations/reconcile'

export type InvitationActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Re-check which repository invitations have actually been accepted.
 *
 * Needed because acceptance happens on GitHub and tells this app nothing: the row
 * keeps its invitation id, and both the student's page and the instructor's table go
 * on claiming an invitation is outstanding long after it was taken up.
 */
export async function recheckInvitations(
  formData: FormData,
): Promise<InvitationActionResult<{ checked: number; accepted: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, classroomId: true, classroom: { select: { slug: true } } },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  await requireInstructor(assignment.classroomId)

  const result = await reconcileInvitations(assignmentId)

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: result }
}
