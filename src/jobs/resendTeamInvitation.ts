import 'server-only'

import { ClassroomRole } from '@prisma/client'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  cancelOrgInvitation,
  findPendingOrgInvitation,
  getOrgMembership,
} from '@/lib/github/operations/orgMembers'
import { addTeamMembership } from '@/lib/github/operations/teams'

import { enqueue, QUEUES, type ResendTeamInvitationJob } from './queue'

const RESEND_FAILED_PREFIX = 'Could not resend the GitHub team invitation'

/**
 * Replace a student's unaccepted team invitation with a fresh one.
 *
 * A team invitation to someone outside the organization is an organization
 * invitation that names the team, and it expires after seven days like any other.
 * Re-adding a student whose invitation is still pending neither re-sends the email
 * nor extends it, so the outstanding invitation is cancelled first — found by login,
 * since GitHub returned no id when the team membership was created — and the student
 * is added to the team again, which sends a new one.
 *
 * A student who has since become a member — by accepting an invitation this app did
 * not see, or through the classroom's student team — is simply re-added, which takes
 * effect at once with no email, and their membership is recorded as active.
 *
 * Where the classroom grants organization membership, the student's row there is
 * re-invited afterwards, so the fresh invitation carries the student team too.
 */
export async function resendTeamInvitation(job: ResendTeamInvitationJob): Promise<void> {
  const member = await db.teamMember.findUnique({
    where: { id: job.teamMemberId },
    select: {
      id: true,
      userId: true,
      githubMembershipState: true,
      user: { select: { githubLogin: true } },
      team: {
        select: {
          name: true,
          githubTeamSlug: true,
          repo: { select: { id: true, failureReason: true } },
          assignment: {
            select: {
              classroom: {
                select: {
                  id: true,
                  githubOrgLogin: true,
                  installationId: true,
                  studentOrgAccess: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!member || member.githubMembershipState !== 'pending') return
  const login = member.user.githubLogin
  const teamSlug = member.team.githubTeamSlug
  if (!login || !teamSlug) return

  const { classroom } = member.team.assignment
  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId

  try {
    const membership = await getOrgMembership(installationId, org, login)

    if (membership?.state === 'pending') {
      const invitationId = await findPendingOrgInvitation(installationId, org, login)
      if (invitationId !== null) {
        await cancelOrgInvitation(classroom.id, installationId, org, invitationId)
      }
    }

    const { state } = await addTeamMembership(classroom.id, installationId, org, teamSlug, login)

    await db.teamMember.update({
      where: { id: member.id },
      data: { githubMembershipState: state },
    })
    if (member.team.repo) {
      await db.assignmentRepo.update({
        where: { id: member.team.repo.id },
        data: { failureReason: clearResendFailure(member.team.repo.failureReason, login) },
      })
    }

    if (classroom.studentOrgAccess && state === 'pending') {
      const classroomMember = await db.classroomMember.findUnique({
        where: { classroomId_userId: { classroomId: classroom.id, userId: member.userId } },
        select: { id: true, role: true, orgState: true },
      })
      if (classroomMember?.role === ClassroomRole.STUDENT && classroomMember.orgState !== 'removed') {
        // Not a resend: the invitation was just reissued above, and this adds the
        // student team to it and dates it on the classroom's row.
        await enqueue(
          QUEUES.inviteStudentToOrg,
          { classroomMemberId: classroomMember.id },
          { singletonKey: `org-invite:${classroomMember.id}` },
        )
      }
    }
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error

    const reason = error instanceof GitHubDomainError ? error.userMessage : String(error)
    console.warn(
      `[jobs] could not resend team invitation for @${login} to ${org}/${teamSlug}: ${reason}`,
    )

    /*
     * A team member has nowhere to carry a warning, so it goes on the team's
     * repository where the instructor's table shows it — appended, so an existing
     * warning is kept, and prefixed per student so a second resend replaces it.
     */
    if (member.team.repo) {
      const kept = clearResendFailure(member.team.repo.failureReason, login)
      await db.assignmentRepo.update({
        where: { id: member.team.repo.id },
        data: {
          failureReason: [kept, `${RESEND_FAILED_PREFIX} for @${login}: ${reason}`]
            .filter(Boolean)
            .join(' '),
        },
      })
    }
  }
}

/** Drop a previous resend failure for this student from a row's warning, keeping anything else. */
function clearResendFailure(reason: string | null, login: string): string | null {
  if (!reason) return null
  const marker = `${RESEND_FAILED_PREFIX} for @${login}:`
  const start = reason.indexOf(marker)
  if (start === -1) return reason
  // This student's failure runs to the next student's, or to the end.
  const next = reason.indexOf(`${RESEND_FAILED_PREFIX} for @`, start + marker.length)
  const kept = (reason.slice(0, start) + (next === -1 ? '' : reason.slice(next))).trim()
  return kept.length > 0 ? kept : null
}
