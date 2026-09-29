'use server'

import { revalidatePath } from 'next/cache'

import { requireClassroomRole, requireInstructor, requireUser } from '@/lib/auth/dal'
import { enqueueMany, QUEUES } from '@/jobs/queue'
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

/**
 * Send fresh invitations to students who have not accepted theirs — every such
 * student on the assignment, or one when `assignmentRepoId` is given.
 *
 * GitHub expires an invitation after seven days and never re-sends it, so a student
 * who missed or lost the email has no way back in on their own. Queued rather than
 * done here because each resend is two content-creating writes, which a whole class
 * would push past the rate budget partway through a request.
 */
export async function resendInvitations(
  formData: FormData,
): Promise<InvitationActionResult<{ resent: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const assignmentRepoId = String(formData.get('assignmentRepoId') ?? '') || null

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, classroomId: true, classroom: { select: { slug: true } } },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  const rows = await db.assignmentRepo.findMany({
    where: {
      assignmentId,
      status: 'READY',
      invitationId: { not: null },
      userId: { not: null },
      ...(assignmentRepoId ? { id: assignmentRepoId } : {}),
    },
    select: { id: true, fullName: true },
  })

  if (rows.length === 0) return { ok: true, data: { resent: 0 } }

  await enqueueMany(
    QUEUES.resendInvitation,
    rows.map((r) => ({ data: { assignmentRepoId: r.id }, singletonKey: `resend:${r.id}` })),
  )

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.resend_invitations',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: {
        resent: rows.length,
        ...(assignmentRepoId && rows[0].fullName ? { repo: rows[0].fullName } : {}),
      },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { resent: rows.length } }
}

/** How long a student waits between resends of their own invitation. */
const OWN_RESEND_COOLDOWN_MS = 15 * 60 * 1000

/**
 * Student: send yourself a fresh invitation to your own repository.
 *
 * For the student whose invitation expired or whose email went astray, so they can
 * get back in without waiting on the instructor. Only ever their own row — it is
 * looked up by the signed-in user, never by an id from the form.
 *
 * Rate-limited per repository, because each resend spends content budget the whole
 * classroom shares, and a student clicking repeatedly while the email is still on its
 * way would otherwise slow repository creation for everyone else.
 */
export async function resendMyInvitation(
  formData: FormData,
): Promise<InvitationActionResult<{ resent: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const user = await requireUser()

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      classroomId: true,
      classroom: { select: { slug: true, archivedAt: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  await requireClassroomRole(assignment.classroomId)

  if (assignment.classroom.archivedAt) {
    return { ok: false, error: 'This classroom is archived.' }
  }

  const repo = await db.assignmentRepo.findUnique({
    where: { assignmentId_userId: { assignmentId, userId: user.id } },
    select: { id: true, status: true, invitationId: true, fullName: true },
  })
  if (!repo || repo.status !== 'READY' || repo.invitationId === null) {
    return { ok: true, data: { resent: 0 } }
  }

  const recent = await db.auditLog.findFirst({
    where: {
      action: 'assignment.resend_own_invitation',
      targetType: 'assignmentRepo',
      targetId: repo.id,
      createdAt: { gt: new Date(Date.now() - OWN_RESEND_COOLDOWN_MS) },
    },
    select: { createdAt: true },
  })
  if (recent) {
    const minutes = Math.ceil(
      (recent.createdAt.getTime() + OWN_RESEND_COOLDOWN_MS - Date.now()) / 60_000,
    )
    return {
      ok: false,
      error:
        'A new invitation was sent recently — check your email, including spam, and your ' +
        `GitHub notifications. You can request another in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    }
  }

  await enqueueMany(QUEUES.resendInvitation, [
    { data: { assignmentRepoId: repo.id }, singletonKey: `resend:${repo.id}` },
  ])

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.resend_own_invitation',
      targetType: 'assignmentRepo',
      targetId: repo.id,
      detail: { repo: repo.fullName },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { resent: 1 } }
}
