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

/**
 * Queue board work for every repository that can take one.
 *
 * Deliberately not limited to repositories without a board. The job creates a board
 * only when one is missing, but it *always* re-grants access — and access is the part
 * that goes wrong, because a board created before that step existed is invisible to
 * everyone and reads as a 404. Including boards that already exist is what makes this
 * a repair rather than only a backfill.
 */
async function queueBoardWork(assignmentId: string): Promise<number> {
  const repos = await db.assignmentRepo.findMany({
    where: {
      assignmentId,
      // A repository that does not exist yet cannot have a board linked to it; the
      // provisioning job queues one itself when it finishes.
      fullName: { not: null },
      status: 'READY',
    },
    select: { id: true },
  })

  /*
   * Spread over time rather than fired at once.
   *
   * Each board costs two content-creating calls and the budget is a handful per
   * minute, so queueing a whole class simultaneously means almost all of them are
   * refused on their first attempt. Retries recover it, but the instructor watches a
   * table fill with errors in the meantime — which is exactly what happened the first
   * time this ran for twelve students.
   */
  const PER_MINUTE = 2
  for (const [index, repo] of repos.entries()) {
    await enqueue(
      QUEUES.createProjectBoard,
      { assignmentRepoId: repo.id },
      // No singleton key: a repair has to run even though a create for the same
      // repository already completed, and pg-boss would otherwise collapse them.
      { startAfterSeconds: Math.floor(index / PER_MINUTE) * 60 },
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

  const queued = enabled ? await queueBoardWork(assignmentId) : 0

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

  const queued = await queueBoardWork(assignmentId)

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
