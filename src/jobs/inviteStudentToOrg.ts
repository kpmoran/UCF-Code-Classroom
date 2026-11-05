import 'server-only'

import { ClassroomRole } from '@prisma/client'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  cancelOrgInvitation,
  findPendingOrgInvitation,
  getOrgAccessSettings,
  getOrgMembership,
} from '@/lib/github/operations/orgMembers'
import { addTeamMembership } from '@/lib/github/operations/teams'
import { convertPendingRepoInvitations, ensureStudentTeam } from '@/lib/students/orgAccess'
import { orgAccessProblem } from '@/lib/students/orgRules'

import type { InviteStudentToOrgJob } from './queue'

/**
 * Invite one student to the organization, through the classroom's student team.
 *
 * With `resend`, an outstanding invitation is cancelled first and a new one issued:
 * re-adding someone whose invitation is still pending neither re-sends the email nor
 * extends its seven days, the same as for repository invitations.
 *
 * Idempotent: team creation returns an existing team, membership is an upsert, and
 * cancelling an invitation that is already gone is a no-op. A retry after a
 * rate-limit refusal converges on the same state.
 */
export async function inviteStudentToOrg(job: InviteStudentToOrgJob): Promise<void> {
  const member = await db.classroomMember.findUnique({
    where: { id: job.classroomMemberId },
    select: {
      id: true,
      role: true,
      userId: true,
      orgState: true,
      orgJoinedViaClassroom: true,
      user: { select: { githubLogin: true } },
      classroom: {
        select: {
          id: true,
          githubOrgLogin: true,
          installationId: true,
          studentOrgAccess: true,
          archivedAt: true,
        },
      },
    },
  })

  if (!member || member.role !== ClassroomRole.STUDENT) return
  const { classroom } = member
  if (!classroom.studentOrgAccess || classroom.archivedAt) return
  if (member.orgState === 'removed') return
  if (member.orgState === 'active' && !job.resend) return

  const login = member.user.githubLogin
  if (!login) {
    await markFailed(member.id, 'This student has no linked GitHub account.')
    return
  }

  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId

  try {
    /*
     * Checked on every invitation, not only when the feature is switched on: the
     * setting can be changed on GitHub at any time, and a student made a member of an
     * organization with a base permission can read every classmate's repository.
     */
    const problem = orgAccessProblem(await getOrgAccessSettings(installationId, org))
    if (problem) {
      await markFailed(member.id, problem)
      return
    }

    const existing = await getOrgMembership(installationId, org, login)

    if (job.resend && existing?.state === 'pending') {
      const invitationId = await findPendingOrgInvitation(installationId, org, login)
      if (invitationId !== null) {
        await cancelOrgInvitation(classroom.id, installationId, org, invitationId)
      }
    }

    const teamSlug = await ensureStudentTeam(classroom.id)
    const { state } = await addTeamMembership(classroom.id, installationId, org, teamSlug, login)

    await db.classroomMember.update({
      where: { id: member.id },
      data: {
        orgState: state,
        orgFailure: null,
        ...(state === 'pending' ? { orgInvitedAt: new Date() } : {}),
        /*
         * Ours unless they were already an active member. Recorded once and never
         * cleared by a later run, because a second run always sees them as a member —
         * of our making.
         */
        orgJoinedViaClassroom: member.orgJoinedViaClassroom || existing?.state !== 'active',
      },
    })

    if (state === 'active') {
      await convertPendingRepoInvitations(classroom.id, member.userId)
    } else if (job.resend) {
      await reissueTeamInvitations(classroom.id, installationId, org, member.userId, login)
    }
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error
    const reason = error instanceof GitHubDomainError ? error.userMessage : String(error)
    console.warn(`[jobs] could not invite ${login} to ${org}: ${reason}`)
    await markFailed(member.id, reason)
  }
}

/**
 * Put the student back on the assignment teams they were still invited to.
 *
 * GitHub holds one organization invitation per person, naming every team it came
 * through. Cancelling it above dropped the student from any group assignment team
 * whose invitation they had not accepted either, so each is re-added here and
 * lands on the new invitation.
 */
async function reissueTeamInvitations(
  classroomId: string,
  installationId: bigint,
  org: string,
  userId: string,
  login: string,
): Promise<void> {
  const memberships = await db.teamMember.findMany({
    where: {
      userId,
      githubMembershipState: 'pending',
      team: { assignment: { classroomId }, githubTeamSlug: { not: null } },
    },
    select: { id: true, team: { select: { githubTeamSlug: true } } },
  })
  for (const membership of memberships) {
    const { state } = await addTeamMembership(
      classroomId,
      installationId,
      org,
      membership.team.githubTeamSlug!,
      login,
    )
    await db.teamMember.update({
      where: { id: membership.id },
      data: { githubMembershipState: state },
    })
  }
}

async function markFailed(classroomMemberId: string, reason: string): Promise<void> {
  await db.classroomMember.update({
    where: { id: classroomMemberId },
    data: { orgState: 'failed', orgFailure: reason },
  })
}
