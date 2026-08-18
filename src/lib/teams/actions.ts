'use server'

import { RepoStatus } from '@prisma/client'
import { revalidatePath } from 'next/cache'

import { requireClassroomRole, requireInstructor, requireUser } from '@/lib/auth/dal'
import { roleSatisfies } from '@/lib/auth/roles'
import { db } from '@/lib/db'
import { slugifyTeamName } from '@/lib/github/repoName'
import { enqueue, QUEUES } from '@/jobs/queue'

import {
  canCreateTeam,
  canJoinTeam,
  canLeaveTeam,
  validateTeamName,
  type TeamConstraints,
  type TeamSnapshot,
} from './rules'

export type TeamActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Team formation.
 *
 * All rule decisions come from `./rules`, which is pure and exhaustively tested;
 * these functions do the loading, the writing, and the queueing.
 */

type LoadedAssignment = {
  id: string
  classroomId: string
  classroomSlug: string
  archived: boolean
  published: boolean
  type: 'INDIVIDUAL' | 'GROUP'
  constraints: TeamConstraints
  studentPermission: 'PULL' | 'PUSH' | 'MAINTAIN' | 'ADMIN'
}

async function loadGroupAssignment(
  assignmentId: string,
): Promise<LoadedAssignment | null> {
  const row = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      classroomId: true,
      type: true,
      publishedAt: true,
      maxTeams: true,
      maxTeamSize: true,
      teamNamingMode: true,
      studentPermission: true,
      classroom: { select: { slug: true, archivedAt: true } },
    },
  })
  if (!row) return null

  return {
    id: row.id,
    classroomId: row.classroomId,
    classroomSlug: row.classroom.slug,
    archived: row.classroom.archivedAt !== null,
    published: row.publishedAt !== null,
    type: row.type,
    studentPermission: row.studentPermission,
    constraints: {
      maxTeams: row.maxTeams,
      maxTeamSize: row.maxTeamSize,
      teamNamingMode: row.teamNamingMode,
    },
  }
}

async function snapshotTeams(assignmentId: string): Promise<TeamSnapshot[]> {
  const teams = await db.team.findMany({
    where: { assignmentId },
    select: {
      id: true,
      name: true,
      _count: { select: { members: true } },
      repo: { select: { id: true } },
    },
  })

  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: t._count.members,
    hasRepo: t.repo !== null,
  }))
}

/**
 * Ensure a team has a queued repository row and a provisioning job.
 *
 * Called on creation and whenever membership changes, so a late joiner is added
 * to the existing GitHub team rather than getting a second repository. The
 * singleton key collapses repeated enqueues.
 */
async function ensureTeamProvisioning(teamId: string, assignmentId: string): Promise<void> {
  const existing = await db.assignmentRepo.findUnique({
    where: { teamId },
    select: { id: true, status: true },
  })

  const row =
    existing ??
    (await db.assignmentRepo.create({
      data: { assignmentId, teamId, status: RepoStatus.QUEUED },
      select: { id: true, status: true },
    }))

  // Re-run even when READY: the job is idempotent and re-running is exactly how
  // a new member gets added to the GitHub team.
  await enqueue(
    QUEUES.provisionTeamRepo,
    { assignmentRepoId: row.id },
    { singletonKey: row.id },
  )
}

export async function createStudentTeam(
  formData: FormData,
): Promise<TeamActionResult<{ teamId: string }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const rawName = String(formData.get('name') ?? '')
  const user = await requireUser()

  const assignment = await loadGroupAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { role } = await requireClassroomRole(assignment.classroomId)
  const actor = roleSatisfies(role, 'TA') ? 'STAFF' : 'STUDENT'

  if (assignment.type !== 'GROUP') {
    return { ok: false, error: 'This is not a group assignment.' }
  }
  if (assignment.archived) return { ok: false, error: 'This classroom is archived.' }
  if (!assignment.published && actor === 'STUDENT') {
    return { ok: false, error: 'This assignment has not been published yet.' }
  }

  // Students must be on the roster, or their work cannot be attributed.
  if (actor === 'STUDENT') {
    const claim = await db.rosterEntry.findFirst({
      where: { classroomId: assignment.classroomId, claimedByUserId: user.id, removedAt: null },
      select: { id: true },
    })
    if (!claim) {
      return {
        ok: false,
        error:
          'Link your GitHub account to your name on the class roster first, using the invite ' +
          'link from your instructor.',
      }
    }
  }

  const teams = await snapshotTeams(assignmentId)

  const createRule = canCreateTeam(assignment.constraints, teams.length, actor)
  if (!createRule.allowed) return { ok: false, error: createRule.reason }

  const nameRule = validateTeamName(
    rawName,
    teams.map((t) => t.name),
    slugifyTeamName,
  )
  if (!nameRule.allowed) return { ok: false, error: nameRule.reason }

  const membership = await db.teamMember.findFirst({
    where: { userId: user.id, team: { assignmentId } },
    select: { team: { select: { name: true } } },
  })
  if (membership && actor === 'STUDENT') {
    return {
      ok: false,
      error: `You are already on ${membership.team.name}. Leave that team before creating another.`,
    }
  }

  const name = rawName.trim()

  const team = await db.team.create({
    data: {
      assignmentId,
      name,
      createdByUserId: user.id,
      // The creator joins as leader, unless staff created it on someone's behalf.
      ...(actor === 'STUDENT'
        ? { members: { create: { userId: user.id, role: 'LEADER' } } }
        : {}),
    },
    select: { id: true },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'team.create',
      targetType: 'team',
      targetId: team.id,
      detail: { name, assignmentId, by: actor },
    },
  })

  if (actor === 'STUDENT') {
    await ensureTeamProvisioning(team.id, assignmentId)
  }

  revalidatePath(`/classrooms/${assignment.classroomSlug}/assignments/${assignmentId}`)
  return { ok: true, data: { teamId: team.id } }
}

export async function joinTeam(formData: FormData): Promise<TeamActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const teamId = String(formData.get('teamId') ?? '')
  const user = await requireUser()

  const assignment = await loadGroupAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  await requireClassroomRole(assignment.classroomId)

  if (assignment.archived) return { ok: false, error: 'This classroom is archived.' }
  if (!assignment.published) {
    return { ok: false, error: 'This assignment has not been published yet.' }
  }

  const claim = await db.rosterEntry.findFirst({
    where: { classroomId: assignment.classroomId, claimedByUserId: user.id, removedAt: null },
    select: { id: true },
  })
  if (!claim) {
    return {
      ok: false,
      error: 'Link your GitHub account to your name on the class roster first.',
    }
  }

  const teams = await snapshotTeams(assignmentId)
  const target = teams.find((t) => t.id === teamId)
  if (!target) return { ok: false, error: 'That team no longer exists.' }

  const current = await db.teamMember.findFirst({
    where: { userId: user.id, team: { assignmentId } },
    select: { teamId: true },
  })
  const currentSnapshot = current ? (teams.find((t) => t.id === current.teamId) ?? null) : null

  const rule = canJoinTeam(assignment.constraints, target, currentSnapshot)
  if (!rule.allowed) return { ok: false, error: rule.reason }

  // Conditional on the seat still being free: two students clicking join on the
  // last seat at once must not both succeed. The unique constraint on
  // (teamId, userId) plus a re-count inside the transaction gives that.
  try {
    await db.$transaction(async (tx) => {
      if (assignment.constraints.maxTeamSize !== null) {
        const count = await tx.teamMember.count({ where: { teamId } })
        if (count >= assignment.constraints.maxTeamSize) {
          throw new Error('TEAM_FULL')
        }
      }
      await tx.teamMember.create({ data: { teamId, userId: user.id, role: 'MEMBER' } })
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'TEAM_FULL') {
      return {
        ok: false,
        error: `${target.name} filled up a moment before you. Pick another team.`,
      }
    }
    throw error
  }

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'team.join',
      targetType: 'team',
      targetId: teamId,
      detail: { teamName: target.name },
    },
  })

  // Re-provision so a late joiner is added to the existing GitHub team.
  await ensureTeamProvisioning(teamId, assignmentId)

  revalidatePath(`/classrooms/${assignment.classroomSlug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}

export async function leaveTeam(formData: FormData): Promise<TeamActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const user = await requireUser()

  const assignment = await loadGroupAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { role } = await requireClassroomRole(assignment.classroomId)
  const actor = roleSatisfies(role, 'TA') ? 'STAFF' : 'STUDENT'

  const membership = await db.teamMember.findFirst({
    where: { userId: user.id, team: { assignmentId } },
    select: { id: true, teamId: true },
  })
  if (!membership) return { ok: false, error: 'You are not on a team for this assignment.' }

  const teams = await snapshotTeams(assignmentId)
  const snapshot = teams.find((t) => t.id === membership.teamId)
  if (!snapshot) return { ok: false, error: 'That team no longer exists.' }

  const rule = canLeaveTeam(snapshot, actor)
  if (!rule.allowed) return { ok: false, error: rule.reason }

  await db.teamMember.delete({ where: { id: membership.id } })

  // An empty team with no repository is tidied away, so the team list does not
  // fill with abandoned shells that count against maxTeams.
  const remaining = await db.teamMember.count({ where: { teamId: membership.teamId } })
  if (remaining === 0 && !snapshot.hasRepo) {
    await db.team.delete({ where: { id: membership.teamId } })
  }

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'team.leave',
      targetType: 'team',
      targetId: membership.teamId,
      detail: { teamName: snapshot.name, teamDeleted: remaining === 0 && !snapshot.hasRepo },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroomSlug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}

/** Instructor: provision a team's repository without waiting for the student. */
export async function provisionTeamNow(formData: FormData): Promise<TeamActionResult> {
  const teamId = String(formData.get('teamId') ?? '')

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      assignmentId: true,
      assignment: { select: { classroomId: true, classroom: { select: { slug: true } } } },
      _count: { select: { members: true } },
    },
  })
  if (!team) return { ok: false, error: 'That team no longer exists.' }

  const { user } = await requireInstructor(team.assignment.classroomId)

  if (team._count.members === 0) {
    return { ok: false, error: `${team.name} has no members yet.` }
  }

  await ensureTeamProvisioning(team.id, team.assignmentId)

  await db.auditLog.create({
    data: {
      classroomId: team.assignment.classroomId,
      actorUserId: user.id,
      action: 'team.provision',
      targetType: 'team',
      targetId: team.id,
      detail: { teamName: team.name },
    },
  })

  revalidatePath(
    `/classrooms/${team.assignment.classroom.slug}/assignments/${team.assignmentId}`,
  )
  return { ok: true, data: undefined }
}

/** Instructor: move a student to another team, or off their team entirely. */
export async function moveStudentToTeam(
  formData: FormData,
): Promise<TeamActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const studentUserId = String(formData.get('studentUserId') ?? '')
  const targetTeamId = String(formData.get('targetTeamId') ?? '')

  const assignment = await loadGroupAssignment(assignmentId)
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  const existing = await db.teamMember.findFirst({
    where: { userId: studentUserId, team: { assignmentId } },
    select: { id: true, teamId: true, team: { select: { name: true } } },
  })

  // Empty target means "remove from their team".
  if (!targetTeamId) {
    if (!existing) return { ok: false, error: 'That student is not on a team.' }
    await db.teamMember.delete({ where: { id: existing.id } })

    await db.auditLog.create({
      data: {
        classroomId: assignment.classroomId,
        actorUserId: user.id,
        action: 'team.remove_member',
        targetType: 'team',
        targetId: existing.teamId,
        detail: { studentUserId, teamName: existing.team.name },
      },
    })

    revalidatePath(`/classrooms/${assignment.classroomSlug}/assignments/${assignmentId}`)
    return { ok: true, data: undefined }
  }

  const target = await db.team.findFirst({
    where: { id: targetTeamId, assignmentId },
    select: { id: true, name: true },
  })
  if (!target) return { ok: false, error: 'That team no longer exists.' }

  if (existing?.teamId === target.id) {
    return { ok: false, error: `They are already on ${target.name}.` }
  }

  await db.$transaction(async (tx) => {
    if (existing) await tx.teamMember.delete({ where: { id: existing.id } })
    await tx.teamMember.create({
      data: { teamId: target.id, userId: studentUserId, role: 'MEMBER' },
    })
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'team.move_member',
      targetType: 'team',
      targetId: target.id,
      detail: { studentUserId, from: existing?.team.name ?? null, to: target.name },
    },
  })

  // The new team may need the member added on GitHub. The old team's GitHub
  // membership is left alone deliberately: revoking it would cut the student off
  // from commits they already made, which is a decision for the instructor to
  // make explicitly rather than a side effect of a move.
  await ensureTeamProvisioning(target.id, assignmentId)

  revalidatePath(`/classrooms/${assignment.classroomSlug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}
