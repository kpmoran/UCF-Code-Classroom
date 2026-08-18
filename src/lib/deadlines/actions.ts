'use server'

import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { parseDeadline } from '@/lib/assignments/schemas'
import { db } from '@/lib/db'
import { enqueue, QUEUES } from '@/jobs/queue'

export type DeadlineActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Deadline and extension management.
 *
 * Every mutation ends by enqueuing a deadline sweep so the effect is visible
 * within seconds rather than at the next scheduled pass. The sweep is idempotent,
 * so triggering it early is free.
 */

async function loadAssignment(assignmentId: string) {
  return db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      deadline: true,
      lockOnDeadline: true,
      classroomId: true,
      classroom: { select: { slug: true } },
    },
  })
}

/** Change an assignment's deadline, or remove it. */
export async function setAssignmentDeadline(
  formData: FormData,
): Promise<DeadlineActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const deadlineRaw = String(formData.get('deadline') ?? '')
  const lockOnDeadline = formData.get('lockOnDeadline') === 'on'

  const assignment = await loadAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  const deadline = parseDeadline(deadlineRaw || null)
  if (deadline === undefined) {
    return { ok: false, error: 'That date and time could not be understood.' }
  }

  await db.assignment.update({
    where: { id: assignmentId },
    data: { deadline, lockOnDeadline },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.deadline_change',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: {
        title: assignment.title,
        from: assignment.deadline?.toISOString() ?? null,
        to: deadline?.toISOString() ?? null,
        lockOnDeadline,
      },
    },
  })

  // Removing a deadline or moving it later must release locked repositories
  // promptly, not at the next scheduled sweep.
  await enqueue(QUEUES.enforceDeadlines, {}, { singletonKey: 'deadline-sweep-adhoc' })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}

/**
 * Grant or update an extension for one student or one team.
 *
 * Upserted rather than duplicated: an instructor extending twice means "the new
 * date", not two competing extensions.
 */
export async function grantExtension(
  formData: FormData,
): Promise<DeadlineActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const userId = String(formData.get('userId') ?? '') || null
  const teamId = String(formData.get('teamId') ?? '') || null
  const deadlineRaw = String(formData.get('newDeadline') ?? '')
  const reason = String(formData.get('reason') ?? '').trim() || null

  const assignment = await loadAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  // Exactly one target — the database enforces this too, but a clear message
  // beats a constraint violation.
  if ((userId === null) === (teamId === null)) {
    return { ok: false, error: 'Choose either a student or a team to extend, not both.' }
  }

  const newDeadline = parseDeadline(deadlineRaw)
  if (newDeadline === undefined) {
    return { ok: false, error: 'That date and time could not be understood.' }
  }
  if (newDeadline === null) {
    return { ok: false, error: 'Pick the new deadline for this extension.' }
  }

  // The target must belong to this assignment's classroom.
  if (userId) {
    const member = await db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: assignment.classroomId, userId } },
      select: { id: true },
    })
    if (!member) return { ok: false, error: 'That student is not in this classroom.' }
  } else if (teamId) {
    const team = await db.team.findFirst({
      where: { id: teamId, assignmentId },
      select: { id: true },
    })
    if (!team) return { ok: false, error: 'That team is not part of this assignment.' }
  }

  const existing = await db.extension.findFirst({
    where: { assignmentId, ...(userId ? { userId } : { teamId }) },
    select: { id: true, newDeadline: true },
  })

  if (existing) {
    await db.extension.update({
      where: { id: existing.id },
      data: { newDeadline, reason, grantedByUserId: user.id },
    })
  } else {
    await db.extension.create({
      data: {
        assignmentId,
        userId,
        teamId,
        newDeadline,
        reason,
        grantedByUserId: user.id,
      },
    })
  }

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: existing ? 'extension.update' : 'extension.grant',
      targetType: userId ? 'user' : 'team',
      targetId: userId ?? teamId,
      detail: {
        assignmentTitle: assignment.title,
        from: existing?.newDeadline.toISOString() ?? assignment.deadline?.toISOString() ?? null,
        to: newDeadline.toISOString(),
        reason,
      },
    },
  })

  // An extension for an already-locked repository must restore write access now.
  await enqueue(QUEUES.enforceDeadlines, {}, { singletonKey: 'deadline-sweep-adhoc' })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}

/** Withdraw an extension, returning the student to the assignment deadline. */
export async function revokeExtension(
  formData: FormData,
): Promise<DeadlineActionResult> {
  const extensionId = String(formData.get('extensionId') ?? '')

  const extension = await db.extension.findUnique({
    where: { id: extensionId },
    select: {
      id: true,
      userId: true,
      teamId: true,
      newDeadline: true,
      assignmentId: true,
      assignment: {
        select: {
          title: true,
          classroomId: true,
          classroom: { select: { slug: true } },
        },
      },
    },
  })
  if (!extension) return { ok: false, error: 'That extension no longer exists.' }

  const { user } = await requireInstructor(extension.assignment.classroomId)

  await db.extension.delete({ where: { id: extension.id } })

  await db.auditLog.create({
    data: {
      classroomId: extension.assignment.classroomId,
      actorUserId: user.id,
      action: 'extension.revoke',
      targetType: extension.userId ? 'user' : 'team',
      targetId: extension.userId ?? extension.teamId,
      detail: {
        assignmentTitle: extension.assignment.title,
        wasExtendedTo: extension.newDeadline.toISOString(),
      },
    },
  })

  // Withdrawing an extension may mean the repository should now be locked.
  await enqueue(QUEUES.enforceDeadlines, {}, { singletonKey: 'deadline-sweep-adhoc' })

  revalidatePath(
    `/classrooms/${extension.assignment.classroom.slug}/assignments/${extension.assignmentId}`,
  )
  return { ok: true, data: undefined }
}

/** Run the deadline sweep now, for an instructor who does not want to wait. */
export async function runDeadlineSweep(
  formData: FormData,
): Promise<DeadlineActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const assignment = await loadAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  await requireInstructor(assignment.classroomId)
  await enqueue(QUEUES.enforceDeadlines, {}, { singletonKey: 'deadline-sweep-adhoc' })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}
