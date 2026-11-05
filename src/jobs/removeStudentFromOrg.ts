import 'server-only'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  convertToOutsideCollaborator,
  getOrgMembership,
  removeOrgMember,
} from '@/lib/github/operations/orgMembers'
import { orgRemovalDecisionFor } from '@/lib/students/orgAccess'

import type { RemoveStudentFromOrgJob } from './queue'

/**
 * Take one student out of the organization — at the end of a term, or when they
 * are removed from the classroom.
 *
 * `CONVERT` makes them an outside collaborator: they leave the organization but keep
 * direct access to their own repositories, so nobody loses their work. `REMOVE` takes
 * them out entirely, repositories included.
 *
 * Refuses — and says why on the member's row — for anyone this classroom does not own
 * the membership of. See `decideOrgRemoval`.
 *
 * The membership row may already be gone: removing someone from the classroom deletes
 * it before this runs. The job then works from the user and the facts the payload
 * carried, and has nowhere to record its outcome but the log.
 */
export async function removeStudentFromOrg(job: RemoveStudentFromOrgJob): Promise<void> {
  const [classroom, user, member] = await Promise.all([
    db.classroom.findUnique({
      where: { id: job.classroomId },
      select: { id: true, githubOrgLogin: true, installationId: true },
    }),
    db.user.findUnique({ where: { id: job.userId }, select: { githubLogin: true } }),
    db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: job.classroomId, userId: job.userId } },
      select: { id: true, orgJoinedViaClassroom: true },
    }),
  ])
  if (!classroom || !user) return

  const login = user.githubLogin
  if (!login) return

  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId
  const joinedViaClassroom = member?.orgJoinedViaClassroom ?? job.joinedViaClassroom ?? false

  const record = async (data: { orgState?: string; orgFailure: string | null }) => {
    if (member) await db.classroomMember.update({ where: { id: member.id }, data })
  }

  try {
    const membership = await getOrgMembership(installationId, org, login)
    if (!membership) {
      await record({ orgState: 'removed', orgFailure: null })
      return
    }

    const decision = await orgRemovalDecisionFor({
      classroomId: classroom.id,
      userId: job.userId,
      org,
      joinedViaClassroom,
      orgRole: membership.role,
    })
    if (!decision.remove) {
      console.warn(`[jobs] left ${login} in ${org}: ${decision.reason}`)
      await record({ orgFailure: `Left in the organization: ${login} ${decision.reason}.` })
      return
    }

    // A pending invitation has no membership to convert; removing cancels it.
    if (job.mode === 'CONVERT' && membership.state === 'active') {
      await convertToOutsideCollaborator(classroom.id, installationId, org, login)
    } else {
      await removeOrgMember(classroom.id, installationId, org, login)
    }

    await record({ orgState: 'removed', orgFailure: null })
  } catch (error) {
    if (error instanceof GitHubDomainError && error.retryable) throw error
    const reason = error instanceof GitHubDomainError ? error.userMessage : String(error)
    console.warn(`[jobs] could not remove ${login} from ${org}: ${reason}`)
    await record({ orgFailure: `Could not remove from the organization: ${reason}` })
  }
}
