'use server'

import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { enqueue, QUEUES } from '@/jobs/queue'

export type ProjectBoardActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Project board management for an assignment.
 *
 * Boards are created by a job, never inline, for the same reason feedback pull
 * requests are: one GitHub write per repository, against the same rate budget as
 * generating repositories. Both actions here queue work and return how much.
 */

/** Queue a board for every repository that is ready and does not have one. */
async function queueMissingBoards(assignmentId: string): Promise<number> {
  const repos = await db.assignmentRepo.findMany({
    where: {
      assignmentId,
      projectUrl: null,
      // A repository that does not exist yet cannot have a board linked to it; the
      // provisioning job queues one itself when it finishes.
      fullName: { not: null },
      status: 'READY',
    },
    select: { id: true },
  })

  for (const repo of repos) {
    await enqueue(
      QUEUES.createProjectBoard,
      { assignmentRepoId: repo.id },
      { singletonKey: `board:${repo.id}` },
    )
  }
  return repos.length
}

/**
 * Turn boards on or off for an assignment.
 *
 * Switching them on backfills: repositories provisioned before the setting existed,
 * or before it was ticked, are exactly the case this has to handle — an assignment is
 * usually well under way before anyone decides they want boards.
 *
 * Switching off leaves existing boards alone. They may already hold a student's
 * planning, and deleting that to honour a checkbox would be the wrong reading of it.
 */
export async function setProjectBoardEnabled(
  formData: FormData,
): Promise<ProjectBoardActionResult<{ queued: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const enabled = formData.get('enabled') === 'true'

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, classroomId: true, classroom: { select: { slug: true } } },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  await db.assignment.update({
    where: { id: assignmentId },
    data: { projectBoardEnabled: enabled },
  })

  const queued = enabled ? await queueMissingBoards(assignmentId) : 0

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: enabled ? 'assignment.project_boards_on' : 'assignment.project_boards_off',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { queued },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { queued } }
}

/** Create any boards still missing, for repositories that already exist. */
export async function createMissingProjectBoards(
  formData: FormData,
): Promise<ProjectBoardActionResult<{ queued: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      classroomId: true,
      projectBoardEnabled: true,
      classroom: { select: { slug: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  if (!assignment.projectBoardEnabled) {
    return { ok: false, error: 'Project boards are not enabled for this assignment.' }
  }

  const queued = await queueMissingBoards(assignmentId)

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.project_boards_backfill',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { queued },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { queued } }
}
