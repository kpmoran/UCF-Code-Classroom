import 'server-only'

import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { cancelInvitation, removeCollaborator } from '@/lib/github/operations/collaborators'
import { archiveRepo, deleteRepo } from '@/lib/github/operations/repos'
import { removeTeamMembership } from '@/lib/github/operations/teams'

import type { RevokeStudentAccessJob } from './queue'

/**
 * Revoke a student's GitHub access to their assignment repositories.
 *
 * Idempotent throughout: each GitHub operation treats "already gone" as success,
 * so a retry after a rate-limit refusal finishes the job rather than erroring on
 * the parts that already succeeded.
 *
 * `repoAction` is the instructor's explicit choice and deliberately defaults to
 * the least destructive option upstream:
 *
 *   KEEP     Access revoked, repository untouched. The student's work survives
 *            and the instructor can still read it. This is the right answer for
 *            a student who dropped the course.
 *   ARCHIVE  Repository made read-only on GitHub. Reversible.
 *   DELETE   Repository permanently removed. Irreversible on GitHub's side, so
 *            callers must have taken typed confirmation first.
 */
export async function revokeStudentAccess(job: RevokeStudentAccessJob): Promise<void> {
  const classroom = await db.classroom.findUnique({
    where: { id: job.classroomId },
    select: { id: true, githubOrgLogin: true, installationId: true },
  })
  if (!classroom) {
    console.warn(`[jobs] classroom ${job.classroomId} no longer exists; skipping revoke`)
    return
  }

  const user = await db.user.findUnique({
    where: { id: job.userId },
    select: { id: true, githubLogin: true },
  })
  if (!user) {
    console.warn(`[jobs] user ${job.userId} no longer exists; skipping revoke`)
    return
  }

  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId

  // Individual repositories the student owns directly.
  const ownRepos = await db.assignmentRepo.findMany({
    where: {
      userId: user.id,
      assignment: {
        classroomId: classroom.id,
        ...(job.assignmentId ? { id: job.assignmentId } : {}),
      },
    },
    select: { id: true, fullName: true, invitationId: true, assignmentId: true },
  })

  // Team repositories the student can reach through a GitHub team.
  const teamMemberships = await db.teamMember.findMany({
    where: {
      userId: user.id,
      team: {
        assignment: {
          classroomId: classroom.id,
          ...(job.assignmentId ? { id: job.assignmentId } : {}),
        },
      },
    },
    select: {
      id: true,
      team: { select: { id: true, name: true, githubTeamSlug: true } },
    },
  })

  const failures: string[] = []

  for (const repo of ownRepos) {
    if (!repo.fullName) continue
    const name = repo.fullName.split('/')[1]

    try {
      if (user.githubLogin) {
        // Removing a collaborator also cancels an unaccepted invitation, but the
        // invitation is cancelled explicitly too: a student who never accepted is
        // not a collaborator, so the first call is a no-op for them.
        await removeCollaborator(installationId, org, name, user.githubLogin)
      }
      if (repo.invitationId) {
        await cancelInvitation(installationId, org, name, repo.invitationId)
      }

      await applyRepoAction(installationId, org, name, job.repoAction)

      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: {
          invitationId: null,
          ...(job.repoAction === 'DELETE'
            ? { githubRepoId: null, htmlUrl: null, failureReason: 'Repository deleted.' }
            : job.repoAction === 'ARCHIVE'
              ? { failureReason: 'Repository archived (read-only on GitHub).' }
              : { failureReason: 'Access revoked; repository left intact.' }),
        },
      })
    } catch (error) {
      const message = error instanceof GitHubDomainError ? error.userMessage : String(error)
      failures.push(`${repo.fullName}: ${message}`)
      if (error instanceof GitHubDomainError && error.retryable) throw error
    }
  }

  for (const membership of teamMemberships) {
    const slug = membership.team.githubTeamSlug
    if (!slug || !user.githubLogin) continue

    try {
      await removeTeamMembership(classroom.id, installationId, org, slug, user.githubLogin)
      await db.teamMember.update({
        where: { id: membership.id },
        data: { githubMembershipState: null },
      })
    } catch (error) {
      const message = error instanceof GitHubDomainError ? error.userMessage : String(error)
      failures.push(`team ${membership.team.name}: ${message}`)
      if (error instanceof GitHubDomainError && error.retryable) throw error
    }
  }

  await db.auditLog.create({
    data: {
      classroomId: classroom.id,
      // No actor: this records the job's outcome, not a person's action. The
      // instructor's decision is audited separately at the point they made it.
      action: 'github.access_revoked',
      targetType: 'user',
      targetId: user.id,
      detail: {
        githubLogin: user.githubLogin,
        assignmentId: job.assignmentId ?? null,
        repoAction: job.repoAction,
        individualRepos: ownRepos.length,
        teamMemberships: teamMemberships.length,
        failures,
      },
    },
  })

  if (failures.length > 0) {
    console.warn(
      `[jobs] revoke for ${user.githubLogin ?? user.id} completed with ${failures.length} ` +
        `problem(s): ${failures.join('; ')}`,
    )
  }
}

async function applyRepoAction(
  installationId: bigint,
  org: string,
  repo: string,
  action: RevokeStudentAccessJob['repoAction'],
): Promise<void> {
  if (action === 'ARCHIVE') {
    await archiveRepo(installationId, org, repo)
  } else if (action === 'DELETE') {
    await deleteRepo(installationId, org, repo)
  }
  // KEEP: nothing to do on the repository itself.
}
