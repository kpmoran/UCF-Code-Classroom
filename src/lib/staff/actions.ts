'use server'

import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { syncStaffTeam } from '@/lib/staff/team'
import { enqueue, QUEUES } from '@/jobs/queue'

export type StaffAccessActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Give this classroom's instructors and TAs access to its student repositories.
 *
 * The team and its memberships are handled here rather than in the job, on
 * purpose. They are a handful of calls, they happen once per classroom rather than
 * once per repository, and their failures are the ones an instructor has to act on
 * — no owner credential connected, or a TA who never linked a GitHub account.
 * Buried in a background job those become a note on a student's row; here they come
 * straight back to the person who pressed the button.
 *
 * Granting each repository is queued, because that part is one GitHub write per
 * repository against the same budget as provisioning.
 */
export async function grantStaffAccess(
  formData: FormData,
): Promise<StaffAccessActionResult<{ queued: number; synced: number; unlinked: string[] }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const classroom = await db.classroom.findUnique({
    where: { id: classroomId },
    select: { id: true, slug: true },
  })
  if (!classroom) return { ok: false, error: 'That classroom no longer exists.' }

  const { user } = await requireInstructor(classroom.id)

  let sync
  try {
    sync = await syncStaffTeam(classroom.id)
  } catch (error) {
    // The common failure is that creating an org team needs the organization-owner
    // credential and none is connected. teamMutate already phrases that usefully, so
    // pass it through rather than replacing it with something vaguer.
    const message =
      error instanceof GitHubDomainError
        ? error.userMessage
        : `The staff team could not be set up: ${(error as Error).message}`
    return { ok: false, error: message }
  }

  // Every repository that exists, not only ones missing access: adding a team is
  // idempotent, and re-running is how a classroom whose staff changed gets fixed.
  const repos = await db.assignmentRepo.findMany({
    where: {
      assignment: assignmentId ? { id: assignmentId } : { classroomId: classroom.id },
      fullName: { not: null },
      status: 'READY',
    },
    select: { id: true },
  })

  let queued = 0
  for (const [index, repo] of repos.entries()) {
    const id = await enqueue(
      QUEUES.grantStaffRepoAccess,
      { assignmentRepoId: repo.id },
      // Two a minute, the same pacing as the board backfill, so a whole class does
      // not spend the minute's budget at once.
      { startAfterSeconds: Math.floor(index / 2) * 60 },
    )
    // Count what pg-boss accepted rather than what we asked for; send() returns null
    // when it declines, and reporting the intended number makes a silent failure
    // indistinguishable from success.
    if (id) queued += 1
  }

  await db.auditLog.create({
    data: {
      classroomId: classroom.id,
      actorUserId: user.id,
      action: 'classroom.staff_access_granted',
      targetType: assignmentId ? 'assignment' : 'classroom',
      targetId: assignmentId || classroom.id,
      detail: {
        teamSlug: sync.teamSlug,
        synced: sync.synced.length,
        unlinked: sync.unlinked,
        queued,
      },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}`)
  if (assignmentId) {
    revalidatePath(`/classrooms/${classroom.slug}/assignments/${assignmentId}`)
  }

  return {
    ok: true,
    data: { queued, synced: sync.synced.length, unlinked: sync.unlinked },
  }
}
