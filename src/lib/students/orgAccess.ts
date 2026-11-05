import 'server-only'

import { ClassroomRole } from '@prisma/client'

import { enqueueMany, QUEUES } from '@/jobs/queue'
import { db } from '@/lib/db'
import { getOrgMembership } from '@/lib/github/operations/orgMembers'
import { createTeam } from '@/lib/github/operations/teams'

import { decideOrgRemoval, studentTeamName, type OrgRemovalDecision } from './orgRules'

/**
 * Students as organization members.
 *
 * The problem this solves: a student added to an organization repository as an
 * outside collaborator gets an invitation per repository, which expires after seven
 * days and is never re-sent. Every assignment was another chance to miss one. An
 * organization *member* added to a repository gets access immediately, with no
 * invitation — so a student who accepts one organization invitation when they join
 * the classroom never sees another.
 *
 * The invitation goes through a per-classroom team rather than straight to the
 * organization. That keeps each course's students identifiable on GitHub, and it uses
 * the membership path already verified to work with the App's own token. The team
 * holds membership only and is never granted a repository: deadline locking lowers a
 * student's *direct* permission, and a team grant would outrank it.
 *
 * Provisioning itself is unchanged. `addCollaborator` already reports a member added
 * directly as having no invitation. A student whose organization invitation is still
 * pending when they accept an assignment gets a repository invitation as before, and
 * that invitation is replaced by direct access once they join (see
 * `convertPendingRepoInvitations`).
 */

/** Make the classroom's student team exist, and remember its slug. */
export async function ensureStudentTeam(classroomId: string): Promise<string> {
  const classroom = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: {
      name: true,
      courseCode: true,
      term: true,
      githubOrgLogin: true,
      installationId: true,
      studentTeamSlug: true,
    },
  })

  const { team } = await createTeam(
    classroomId,
    classroom.installationId,
    classroom.githubOrgLogin,
    studentTeamName(classroom),
    `Students in ${classroom.name}. Membership only; grants no repository access.`,
  )

  if (classroom.studentTeamSlug !== team.slug) {
    await db.classroom.update({ where: { id: classroomId }, data: { studentTeamSlug: team.slug } })
  }
  return team.slug
}

/**
 * Replace a newly joined member's outstanding repository invitations with direct
 * access.
 *
 * A student who accepted an assignment before accepting the organization invitation
 * was given a repository invitation, because they were not a member yet. Now they
 * are, re-adding them grants access outright — which is exactly what the resend job
 * does, since it cancels the old invitation and adds them again.
 */
export async function convertPendingRepoInvitations(
  classroomId: string,
  userId: string,
): Promise<number> {
  const rows = await db.assignmentRepo.findMany({
    where: {
      userId,
      status: 'READY',
      invitationId: { not: null },
      assignment: { classroomId },
    },
    select: { id: true },
  })
  return enqueueMany(
    QUEUES.resendInvitation,
    rows.map((r) => ({ data: { assignmentRepoId: r.id }, singletonKey: `resend:${r.id}` })),
  )
}

/**
 * Ask GitHub whether outstanding organization invitations have been accepted.
 *
 * Needed for the same reason as the repository version: accepting happens on GitHub
 * and the App hears nothing about it. Reads only, so it costs no content budget.
 *
 * Asks about organization membership rather than team membership, because
 * organization membership is what grants repositories directly. A member who
 * disappears from the pending list without becoming one declined, or let the
 * invitation expire.
 */
export async function reconcileOrgMemberships(
  classroomId: string,
  options: { classroomMemberId?: string } = {},
): Promise<{ checked: number; activated: number }> {
  const classroom = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { githubOrgLogin: true, installationId: true },
  })

  const members = await db.classroomMember.findMany({
    where: {
      classroomId,
      role: ClassroomRole.STUDENT,
      orgState: { in: ['pending', 'expired'] },
      ...(options.classroomMemberId ? { id: options.classroomMemberId } : {}),
    },
    select: { id: true, userId: true, orgState: true, user: { select: { githubLogin: true } } },
  })

  let activated = 0
  const BATCH = 10
  for (let i = 0; i < members.length; i += BATCH) {
    await Promise.all(
      members.slice(i, i + BATCH).map(async (member) => {
        const login = member.user.githubLogin
        if (!login) return
        let membership
        try {
          membership = await getOrgMembership(
            classroom.installationId,
            classroom.githubOrgLogin,
            login,
          )
        } catch {
          // One failed read must not abandon the rest of the class.
          return
        }

        const state = membership?.state ?? 'expired'
        if (state === member.orgState) return

        await db.classroomMember.update({
          where: { id: member.id },
          data: { orgState: state, ...(state === 'active' ? { orgFailure: null } : {}) },
        })
        if (state === 'active') {
          activated += 1
          await convertPendingRepoInvitations(classroomId, member.userId)
        }
      }),
    )
  }

  return { checked: members.length, activated }
}

/**
 * Whether this classroom may take a student out of the organization, with the facts
 * gathered from the database. Membership itself is read by the caller, which needs it
 * anyway.
 */
export async function orgRemovalDecisionFor(input: {
  classroomId: string
  userId: string
  org: string
  joinedViaClassroom: boolean
  orgRole: string | null
}): Promise<OrgRemovalDecision> {
  const elsewhere = {
    userId: input.userId,
    classroomId: { not: input.classroomId },
    classroom: { githubOrgLogin: input.org },
  }
  const [staffElsewhere, studentElsewhere] = await Promise.all([
    db.classroomMember.count({
      where: { ...elsewhere, role: { in: [ClassroomRole.INSTRUCTOR, ClassroomRole.TA] } },
    }),
    db.classroomMember.count({
      where: {
        ...elsewhere,
        role: ClassroomRole.STUDENT,
        classroom: { githubOrgLogin: input.org, archivedAt: null, studentOrgAccess: true },
      },
    }),
  ])

  return decideOrgRemoval({
    joinedViaClassroom: input.joinedViaClassroom,
    orgRole: input.orgRole,
    staffInAnotherClassroom: staffElsewhere > 0,
    studentInAnotherActiveClassroom: studentElsewhere > 0,
  })
}
