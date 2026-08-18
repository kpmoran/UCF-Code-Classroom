'use server'

import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { enqueue, enqueueMany, QUEUES } from '@/jobs/queue'

export type FeedbackActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Feedback pull request management.
 *
 * The PR itself is opened by a job, never inline: it needs several GitHub calls
 * per repository and a whole class at once would exceed the rate budget.
 */

/** Turn feedback pull requests on or off for an assignment. */
export async function setFeedbackPrEnabled(
  formData: FormData,
): Promise<FeedbackActionResult<{ queued: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const enabled = formData.get('enabled') === 'true'

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      classroomId: true,
      classroom: { select: { slug: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  await db.assignment.update({
    where: { id: assignmentId },
    data: { feedbackPrEnabled: enabled },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: enabled ? 'feedback_pr.enable' : 'feedback_pr.disable',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { title: assignment.title },
    },
  })

  // Enabling it mid-assignment should backfill, so students who already pushed get
  // a PR rather than only future ones.
  let queued = 0
  if (enabled) {
    queued = await queueMissingFeedbackPrs(assignmentId)
  }

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { queued } }
}

/**
 * Open any feedback pull requests still missing for an assignment.
 *
 * The manual equivalent of the periodic sweep, for an instructor who does not want
 * to wait for it.
 */
export async function createMissingFeedbackPrs(
  formData: FormData,
): Promise<FeedbackActionResult<{ queued: number; notPushed: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      feedbackPrEnabled: true,
      classroomId: true,
      classroom: { select: { slug: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  if (!assignment.feedbackPrEnabled) {
    return { ok: false, error: 'Feedback pull requests are not enabled for this assignment.' }
  }

  const queued = await queueMissingFeedbackPrs(assignmentId)

  // Reported separately so "nothing happened" is explained rather than mysterious:
  // a PR cannot exist before the student has pushed anything.
  const notPushed = await db.assignmentRepo.count({
    where: {
      assignmentId,
      status: 'READY',
      feedbackPrNumber: null,
      lastPushedAt: null,
    },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'feedback_pr.backfill',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { title: assignment.title, queued, awaitingFirstPush: notPushed },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { queued, notPushed } }
}

/** Open the feedback pull request for one repository. */
export async function createFeedbackPrForRepo(
  formData: FormData,
): Promise<FeedbackActionResult> {
  const assignmentRepoId = String(formData.get('assignmentRepoId') ?? '')

  const repo = await db.assignmentRepo.findUnique({
    where: { id: assignmentRepoId },
    select: {
      id: true,
      lastPushedAt: true,
      feedbackPrNumber: true,
      assignment: {
        select: {
          id: true,
          feedbackPrEnabled: true,
          classroomId: true,
          classroom: { select: { slug: true } },
        },
      },
    },
  })
  if (!repo) return { ok: false, error: 'That repository record no longer exists.' }

  await requireInstructor(repo.assignment.classroomId)

  if (!repo.assignment.feedbackPrEnabled) {
    return { ok: false, error: 'Feedback pull requests are not enabled for this assignment.' }
  }
  if (repo.feedbackPrNumber !== null) {
    return { ok: false, error: 'This repository already has a feedback pull request.' }
  }
  if (!repo.lastPushedAt) {
    return {
      ok: false,
      error:
        'This student has not pushed anything yet, so there is nothing to review. The pull ' +
        'request opens automatically once they do.',
    }
  }

  await enqueue(
    QUEUES.ensureFeedbackPr,
    { assignmentRepoId: repo.id },
    { singletonKey: `feedback-pr:${repo.id}` },
  )

  revalidatePath(
    `/classrooms/${repo.assignment.classroom.slug}/assignments/${repo.assignment.id}`,
  )
  return { ok: true, data: undefined }
}

/** Queue a feedback PR for every pushed-to repository that lacks one. */
async function queueMissingFeedbackPrs(assignmentId: string): Promise<number> {
  const pending = await db.assignmentRepo.findMany({
    where: {
      assignmentId,
      status: 'READY',
      feedbackPrNumber: null,
      fullName: { not: null },
      // Only repositories with something to review; the rest are picked up when
      // the student first pushes.
      lastPushedAt: { not: null },
    },
    select: { id: true },
  })

  if (pending.length === 0) return 0

  await enqueueMany(
    QUEUES.ensureFeedbackPr,
    pending.map((repo) => ({
      data: { assignmentRepoId: repo.id },
      singletonKey: `feedback-pr:${repo.id}`,
    })),
  )

  return pending.length
}
