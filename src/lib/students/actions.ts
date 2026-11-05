'use server'

import { ClassroomRole } from '@prisma/client'
import { revalidatePath } from 'next/cache'

import { enqueueMany, QUEUES } from '@/jobs/queue'
import { requireClassroomRole, requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { getOrgAccessSettings } from '@/lib/github/operations/orgMembers'

import { reconcileOrgMemberships } from './orgAccess'
import { effectiveOrgState, orgAccessProblem } from './orgRules'

export type StudentOrgActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Organization membership for students, from the instructor's settings page and
 * the student's own classroom page. The rules are in orgRules.ts and the GitHub
 * work in the jobs; what lives here is authorization, the audit trail, and queueing.
 */

function revalidateClassroom(slug: string): void {
  revalidatePath(`/classrooms/${slug}`)
  revalidatePath(`/classrooms/${slug}/people`)
  revalidatePath(`/classrooms/${slug}/settings`)
}

/**
 * Queue invitations for the classroom's students who are not members yet.
 *
 * One student when `classroomMemberId` is given, whatever their state short of
 * removed. Otherwise everyone never invited, failed, or whose invitation has run
 * out — but not a student whose invitation is still live, since cancelling and
 * re-sending it would only confuse someone who has the email in front of them.
 */
async function queueOrgInvitations(
  classroomId: string,
  classroomMemberId: string | null,
): Promise<{ queued: number; login: string | null }> {
  const members = await db.classroomMember.findMany({
    where: {
      classroomId,
      role: ClassroomRole.STUDENT,
      user: { githubLogin: { not: null } },
      ...(classroomMemberId
        ? { id: classroomMemberId, OR: [{ orgState: null }, { orgState: { not: 'removed' } }] }
        : { OR: [{ orgState: null }, { orgState: { in: ['pending', 'expired', 'failed'] } }] }),
    },
    select: { id: true, orgState: true, orgInvitedAt: true, user: { select: { githubLogin: true } } },
  })

  const now = new Date()
  const due = classroomMemberId
    ? members
    : members.filter((m) => effectiveOrgState(m.orgState, m.orgInvitedAt, now) !== 'pending')

  const queued = await enqueueMany(
    QUEUES.inviteStudentToOrg,
    due.map((m) => ({
      data: { classroomMemberId: m.id, resend: true },
      singletonKey: `org-invite:${m.id}`,
    })),
  )
  return { queued, login: classroomMemberId ? (due[0]?.user.githubLogin ?? null) : null }
}

/**
 * Turn organization membership for students on or off.
 *
 * Switching it on first checks the organization's base repository permission, and
 * refuses if membership would let students read each other's work: the setting is
 * the instructor's to fix on GitHub, and silently inviting into a misconfigured
 * organization is the one outcome worse than leaving the feature off. Students
 * already in the classroom are invited straight away.
 *
 * Switching it off stops new invitations. Nobody is removed — that is the explicit
 * end-of-term action below.
 */
export async function setStudentOrgAccess(
  formData: FormData,
): Promise<StudentOrgActionResult<{ enabled: boolean; queued: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const enabled = String(formData.get('enabled') ?? '') === 'true'
  const { user, classroom } = await requireInstructor(classroomId)

  if (enabled) {
    try {
      const problem = orgAccessProblem(
        await getOrgAccessSettings(classroom.installationId, classroom.githubOrgLogin),
      )
      if (problem) return { ok: false, error: problem }
    } catch (error) {
      return {
        ok: false,
        error: `Could not check the organization’s settings: ${
          error instanceof GitHubDomainError ? error.userMessage : 'GitHub did not answer.'
        }`,
      }
    }
  }

  await db.classroom.update({ where: { id: classroomId }, data: { studentOrgAccess: enabled } })

  const { queued } = enabled
    ? await queueOrgInvitations(classroomId, null)
    : { queued: 0 }

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'classroom.student_org_access',
      targetType: 'classroom',
      targetId: classroomId,
      detail: { enabled, queued },
    },
  })

  revalidateClassroom(classroom.slug)
  return { ok: true, data: { enabled, queued } }
}

/**
 * Invite the classroom's students to the organization — all who need it, or one
 * student again when `classroomMemberId` is given.
 */
export async function inviteStudentsToOrg(
  formData: FormData,
): Promise<StudentOrgActionResult<{ queued: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const classroomMemberId = String(formData.get('classroomMemberId') ?? '') || null
  const { user, classroom } = await requireInstructor(classroomId)

  const settings = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { studentOrgAccess: true },
  })
  if (!settings.studentOrgAccess) {
    return { ok: false, error: 'Turn on organization membership for students first.' }
  }
  if (classroom.archivedAt) return { ok: false, error: 'This classroom is archived.' }

  const { queued, login } = await queueOrgInvitations(classroomId, classroomMemberId)
  if (queued === 0) return { ok: true, data: { queued: 0 } }

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'classroom.invite_students_to_org',
      targetType: classroomMemberId ? 'classroomMember' : 'classroom',
      targetId: classroomMemberId ?? classroomId,
      detail: { queued, ...(login ? { githubLogin: login } : {}) },
    },
  })

  revalidateClassroom(classroom.slug)
  return { ok: true, data: { queued } }
}

/**
 * Ask GitHub which outstanding organization invitations have been accepted.
 * Acceptance happens on GitHub and tells this app nothing, so the people page would
 * otherwise go on showing "invited" for good.
 */
export async function recheckOrgInvitations(
  formData: FormData,
): Promise<StudentOrgActionResult<{ checked: number; activated: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { classroom } = await requireInstructor(classroomId)

  const result = await reconcileOrgMemberships(classroomId)

  revalidateClassroom(classroom.slug)
  return { ok: true, data: result }
}

/**
 * End of term: take the classroom's students out of the organization.
 *
 * Queued per student, because each is a GitHub write and a class is a few hundred.
 * The job refuses anyone this classroom did not make a member, and anyone another
 * classroom still needs; see `decideOrgRemoval`. Confirmed by typing the slug,
 * like archiving, because it touches every student at once.
 */
export async function removeStudentsFromOrg(
  formData: FormData,
): Promise<StudentOrgActionResult<{ queued: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const modeInput = String(formData.get('mode') ?? '')
  const confirmSlug = String(formData.get('confirmSlug') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  if (modeInput !== 'CONVERT' && modeInput !== 'REMOVE') {
    return { ok: false, error: 'Choose what should happen to their repository access.' }
  }
  const mode = modeInput
  if (confirmSlug.trim() !== classroom.slug) {
    return { ok: false, error: `Type “${classroom.slug}” exactly to confirm.` }
  }

  const members = await db.classroomMember.findMany({
    where: {
      classroomId,
      role: ClassroomRole.STUDENT,
      orgState: { in: ['pending', 'active', 'expired'] },
      user: { githubLogin: { not: null } },
    },
    select: { userId: true, orgJoinedViaClassroom: true },
  })

  const queued = await enqueueMany(
    QUEUES.removeStudentFromOrg,
    members.map((m) => ({
      data: { classroomId, userId: m.userId, mode, joinedViaClassroom: m.orgJoinedViaClassroom },
      singletonKey: `org-remove:${classroomId}:${m.userId}`,
    })),
  )

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'classroom.remove_students_from_org',
      targetType: 'classroom',
      targetId: classroomId,
      detail: { queued, mode },
    },
  })

  revalidateClassroom(classroom.slug)
  return { ok: true, data: { queued } }
}

/** How long a student waits between resends of their own invitation. */
const OWN_RESEND_COOLDOWN_MS = 15 * 60 * 1000

/**
 * Student: send yourself a fresh invitation to the organization.
 *
 * For the student whose invitation expired or whose email went astray. Only ever
 * their own membership, looked up by the signed-in user. Rate-limited like the
 * repository version, because each resend is organization writes the whole
 * classroom's budget pays for.
 */
export async function resendMyOrgInvitation(
  formData: FormData,
): Promise<StudentOrgActionResult<{ resent: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user, classroom } = await requireClassroomRole(classroomId)

  const [settings, member] = await Promise.all([
    db.classroom.findUniqueOrThrow({
      where: { id: classroom.id },
      select: { studentOrgAccess: true },
    }),
    db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: classroom.id, userId: user.id } },
      select: { id: true, role: true, orgState: true },
    }),
  ])

  if (classroom.archivedAt) return { ok: false, error: 'This classroom is archived.' }
  if (
    !settings.studentOrgAccess ||
    !member ||
    member.role !== ClassroomRole.STUDENT ||
    !['pending', 'expired', 'failed'].includes(member.orgState ?? '')
  ) {
    return { ok: true, data: { resent: 0 } }
  }

  const recent = await db.auditLog.findFirst({
    where: {
      action: 'classroom.resend_own_org_invitation',
      targetType: 'classroomMember',
      targetId: member.id,
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

  await enqueueMany(QUEUES.inviteStudentToOrg, [
    { data: { classroomMemberId: member.id, resend: true }, singletonKey: `org-invite:${member.id}` },
  ])

  await db.auditLog.create({
    data: {
      classroomId: classroom.id,
      actorUserId: user.id,
      action: 'classroom.resend_own_org_invitation',
      targetType: 'classroomMember',
      targetId: member.id,
      detail: { org: classroom.githubOrgLogin },
    },
  })

  revalidateClassroom(classroom.slug)
  return { ok: true, data: { resent: 1 } }
}
