'use server'

import { ClassroomRole } from '@prisma/client'
import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import { OWNER_PROVIDER_ID } from '@/lib/auth/providers'
import { db } from '@/lib/db'
import { enqueue, QUEUES } from '@/jobs/queue'

export type MemberActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Classroom membership management.
 *
 * Two invariants are enforced here rather than trusted to the UI:
 *
 *  - A classroom always retains at least one instructor. Losing the last one
 *    would leave it unmanageable by anyone except a site admin.
 *  - An instructor cannot demote or remove themselves in a way that locks them
 *    out, which is the same rule stated from the acting user's side.
 */

/**
 * Keep the classroom's organization-owner credential attached to someone who is
 * still an instructor of it.
 *
 * `Classroom.ownerTokenUserId` names the person whose stored GitHub token performs
 * privileged organization work — creating teams, adding members who are not yet in
 * the organization. Nothing was clearing it when that person left, so a classroom
 * went on using the token of someone who had just been removed. Two ways that
 * bites: the credential belongs to somebody with no remaining connection to the
 * course, and the moment they disconnect GitHub, group assignments start failing
 * with a 401 that names no cause.
 *
 * Handing off beats clearing where possible, because clearing is only recoverable
 * by a human noticing a warning and reconnecting. So: prefer another instructor who
 * already has a usable owner token, and clear only when there is nobody.
 */
async function handOffOwnerToken(
  classroomId: string,
  departingUserId: string,
  actorUserId: string,
): Promise<'kept' | 'reassigned' | 'cleared'> {
  const classroom = await db.classroom.findUnique({
    where: { id: classroomId },
    select: { ownerTokenUserId: true },
  })
  if (classroom?.ownerTokenUserId !== departingUserId) return 'kept'

  // Another instructor who has actually completed the owner connection. Checked
  // against the account rows rather than assumed, so we never hand the role to
  // someone whose token does not exist — that would look fixed and not be.
  const successor = await db.classroomMember.findFirst({
    where: {
      classroomId,
      role: ClassroomRole.INSTRUCTOR,
      userId: { not: departingUserId },
      user: {
        accounts: {
          some: {
            provider: OWNER_PROVIDER_ID,
            isOwnerToken: true,
            access_token: { not: null },
          },
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true },
  })

  await db.classroom.update({
    where: { id: classroomId },
    data: { ownerTokenUserId: successor?.userId ?? null },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId,
      action: successor ? 'classroom.owner_token_reassigned' : 'classroom.owner_token_cleared',
      targetType: 'classroom',
      targetId: classroomId,
      detail: { from: departingUserId, to: successor?.userId ?? null },
    },
  })

  return successor ? 'reassigned' : 'cleared'
}

export async function setMemberRole(formData: FormData): Promise<MemberActionResult> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const targetUserId = String(formData.get('userId') ?? '')
  const roleInput = String(formData.get('role') ?? '')

  const { user, classroom } = await requireInstructor(classroomId)

  if (!Object.values(ClassroomRole).includes(roleInput as ClassroomRole)) {
    return { ok: false, error: 'That is not a valid role.' }
  }
  const role = roleInput as ClassroomRole

  const membership = await db.classroomMember.findUnique({
    where: { classroomId_userId: { classroomId, userId: targetUserId } },
    select: { id: true, role: true, user: { select: { name: true, githubLogin: true } } },
  })
  if (!membership) return { ok: false, error: 'That person is not in this classroom.' }
  if (membership.role === role) return { ok: true, data: undefined }

  // Guard the last instructor.
  if (membership.role === ClassroomRole.INSTRUCTOR && role !== ClassroomRole.INSTRUCTOR) {
    const instructorCount = await db.classroomMember.count({
      where: { classroomId, role: ClassroomRole.INSTRUCTOR },
    })
    if (instructorCount <= 1) {
      return {
        ok: false,
        error:
          'This is the classroom’s only instructor. Promote someone else to instructor first, ' +
          'otherwise nobody could manage the classroom.',
      }
    }
  }

  await db.classroomMember.update({ where: { id: membership.id }, data: { role } })

  /*
   * Demotion out of INSTRUCTOR is treated the same as leaving, as far as the
   * organization-owner credential goes. The invariant worth holding is simply
   * "the owner token belongs to an instructor of this classroom" — it is easy to
   * state, easy to test, and it keeps a privileged token from sitting with someone
   * who has been moved to TA or student.
   */
  const ownerToken =
    membership.role === ClassroomRole.INSTRUCTOR && role !== ClassroomRole.INSTRUCTOR
      ? await handOffOwnerToken(classroomId, targetUserId, user.id)
      : 'kept'

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'member.role_change',
      targetType: 'user',
      targetId: targetUserId,
      detail: {
        from: membership.role,
        to: role,
        who: membership.user.githubLogin ?? membership.user.name,
        selfChange: targetUserId === user.id,
        ownerToken,
      },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/people`)
  revalidatePath(`/classrooms/${classroom.slug}/settings`)
  return { ok: true, data: undefined }
}

/**
 * Remove someone from a classroom.
 *
 * `repoAction` is the instructor's explicit decision about the student's work,
 * and there is no default: keeping repositories is usually right for a student who
 * dropped, while deletion is occasionally wanted for a test account. Deleting is
 * gated on typed confirmation upstream because GitHub cannot undo it.
 */
export async function removeClassroomMember(
  formData: FormData,
): Promise<MemberActionResult<{ queuedRevoke: boolean; ownerTokenCleared: boolean }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const targetUserId = String(formData.get('userId') ?? '')
  const repoActionInput = String(formData.get('repoAction') ?? 'KEEP')
  const confirmation = String(formData.get('confirm') ?? '')

  const { user, classroom } = await requireInstructor(classroomId)

  if (!['KEEP', 'ARCHIVE', 'DELETE'].includes(repoActionInput)) {
    return { ok: false, error: 'That is not a valid choice for their repositories.' }
  }
  const repoAction = repoActionInput as 'KEEP' | 'ARCHIVE' | 'DELETE'

  const membership = await db.classroomMember.findUnique({
    where: { classroomId_userId: { classroomId, userId: targetUserId } },
    select: {
      id: true,
      role: true,
      user: { select: { id: true, name: true, githubLogin: true } },
    },
  })
  if (!membership) return { ok: false, error: 'That person is not in this classroom.' }

  if (membership.role === ClassroomRole.INSTRUCTOR) {
    const instructorCount = await db.classroomMember.count({
      where: { classroomId, role: ClassroomRole.INSTRUCTOR },
    })
    if (instructorCount <= 1) {
      return {
        ok: false,
        error:
          'This is the classroom’s only instructor and cannot be removed. Promote someone else ' +
          'to instructor first.',
      }
    }
  }

  const label = membership.user.githubLogin ?? membership.user.name ?? 'this person'

  // Deletion is irreversible on GitHub, so require the login typed back.
  if (repoAction === 'DELETE' && confirmation.trim() !== label) {
    return {
      ok: false,
      error: `Type “${label}” exactly to confirm deleting their repositories.`,
    }
  }

  // Unlink the roster entry so the seat can be reclaimed, but keep the entry
  // itself: it is the record that this student was ever enrolled.
  await db.rosterEntry.updateMany({
    where: { classroomId, claimedByUserId: targetUserId },
    data: { claimedByUserId: null, claimedAt: null },
  })

  await db.classroomMember.delete({ where: { id: membership.id } })

  // Before anything else reads the classroom: they may have been holding the
  // organization-owner credential, and it must not outlive their membership.
  const ownerToken = await handOffOwnerToken(classroomId, targetUserId, user.id)

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'member.remove',
      targetType: 'user',
      targetId: targetUserId,
      detail: { who: label, role: membership.role, repoAction, ownerToken },
    },
  })

  // GitHub work happens in the background; see the job for why.
  await enqueue(
    QUEUES.revokeStudentAccess,
    { classroomId, userId: targetUserId, repoAction },
    { singletonKey: `revoke:${classroomId}:${targetUserId}` },
  )

  revalidatePath(`/classrooms/${classroom.slug}/people`)
  revalidatePath(`/classrooms/${classroom.slug}/roster`)
  revalidatePath(`/classrooms/${classroom.slug}/settings`)
  return {
    ok: true,
    data: { queuedRevoke: true, ownerTokenCleared: ownerToken === 'cleared' },
  }
}

/**
 * Remove a student from a single assignment.
 *
 * Separate from classroom removal because the common case is narrower: a student
 * accepted the wrong assignment, or needs a clean start after a botched merge.
 */
export async function removeFromAssignment(
  formData: FormData,
): Promise<MemberActionResult> {
  const assignmentRepoId = String(formData.get('assignmentRepoId') ?? '')
  const repoActionInput = String(formData.get('repoAction') ?? 'KEEP')
  const confirmation = String(formData.get('confirm') ?? '')

  const repo = await db.assignmentRepo.findUnique({
    where: { id: assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      userId: true,
      teamId: true,
      assignmentId: true,
      assignment: {
        select: { classroomId: true, classroom: { select: { slug: true } } },
      },
    },
  })
  if (!repo) return { ok: false, error: 'That repository record no longer exists.' }

  const { user, classroom } = await requireInstructor(repo.assignment.classroomId)

  if (!['KEEP', 'ARCHIVE', 'DELETE'].includes(repoActionInput)) {
    return { ok: false, error: 'That is not a valid choice for the repository.' }
  }
  const repoAction = repoActionInput as 'KEEP' | 'ARCHIVE' | 'DELETE'

  // Confirmation is the repository name, which is what the instructor is looking
  // at and what makes an accidental deletion of the wrong row implausible.
  const repoName = repo.fullName?.split('/')[1] ?? null
  if (repoAction === 'DELETE') {
    if (!repoName) {
      return {
        ok: false,
        error: 'That repository was never created on GitHub, so there is nothing to delete.',
      }
    }
    if (confirmation.trim() !== repoName) {
      return { ok: false, error: `Type “${repoName}” exactly to confirm deletion.` }
    }
  }

  if (repo.userId) {
    await enqueue(
      QUEUES.revokeStudentAccess,
      {
        classroomId: repo.assignment.classroomId,
        userId: repo.userId,
        assignmentId: repo.assignmentId,
        repoAction,
      },
      { singletonKey: `revoke:${repo.assignmentId}:${repo.userId}` },
    )
  }

  // The row is deleted only when the repository is gone too. Otherwise it is kept
  // so the repository stays visible in the overview rather than becoming an
  // untracked repository nobody remembers creating.
  if (repoAction === 'DELETE') {
    await db.assignmentRepo.delete({ where: { id: repo.id } })
  }

  await db.auditLog.create({
    data: {
      classroomId: repo.assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.remove_student',
      targetType: 'assignmentRepo',
      targetId: repo.id,
      detail: { repo: repo.fullName, repoAction, userId: repo.userId, teamId: repo.teamId },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/assignments/${repo.assignmentId}`)
  return { ok: true, data: undefined }
}
