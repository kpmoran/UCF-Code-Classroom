import 'server-only'

import { db } from '@/lib/db'
import { decideDeadlineAction, effectiveDeadline } from '@/lib/deadlines/resolve'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  setCollaboratorPermission,
  toGitHubPermission,
} from '@/lib/github/operations/collaborators'
import { getCommitAsOf, getRepoHead } from '@/lib/github/operations/repos'
import { addTeamRepoAccess } from '@/lib/github/operations/teams'

/**
 * Enforce deadlines across every classroom.
 *
 * Runs on a schedule (every few minutes) rather than as a one-shot job scheduled
 * for each deadline. That choice is deliberate:
 *
 *  - **It survives downtime.** A job scheduled for 23:59 is simply lost if the
 *    server is restarted at 23:55. A sweep notices on its next pass.
 *  - **It reacts to changes.** Granting an extension, editing a deadline, or
 *    turning locking off needs no rescheduling — the next sweep re-derives the
 *    correct state from the data.
 *  - **It is cheap.** Deciding what to do is pure and local; GitHub is only
 *    touched when a repository's state must actually change.
 *
 * Everything it does is idempotent, so running it more often is harmless.
 */

export type DeadlineSweepResult = {
  examined: number
  captured: number
  locked: number
  unlocked: number
  failed: number
}

export async function enforceDeadlines(): Promise<DeadlineSweepResult> {
  const now = new Date()
  const result: DeadlineSweepResult = {
    examined: 0,
    captured: 0,
    locked: 0,
    unlocked: 0,
    failed: 0,
  }

  // Only assignments that could possibly need work: they have a deadline, or
  // they have repositories that are currently locked and may need releasing.
  const assignments = await db.assignment.findMany({
    where: {
      classroom: { archivedAt: null },
      OR: [{ deadline: { not: null } }, { repos: { some: { lockedAt: { not: null } } } }],
    },
    select: {
      id: true,
      title: true,
      deadline: true,
      lockOnDeadline: true,
      studentPermission: true,
      classroom: {
        select: { id: true, githubOrgLogin: true, installationId: true },
      },
      extensions: {
        select: { userId: true, teamId: true, newDeadline: true },
      },
      repos: {
        where: { status: 'READY' },
        select: {
          id: true,
          fullName: true,
          deadlineSha: true,
          lockedAt: true,
          lastPushedAt: true,
          userId: true,
          teamId: true,
          user: { select: { githubLogin: true } },
          team: { select: { githubTeamSlug: true } },
        },
      },
    },
  })

  for (const assignment of assignments) {
    const org = assignment.classroom.githubOrgLogin
    const installationId = assignment.classroom.installationId

    // Index extensions so each repository's override is a lookup, not a scan.
    const byUser = new Map<string, Date>()
    const byTeam = new Map<string, Date>()
    for (const ext of assignment.extensions) {
      if (ext.userId) byUser.set(ext.userId, ext.newDeadline)
      if (ext.teamId) byTeam.set(ext.teamId, ext.newDeadline)
    }

    for (const repo of assignment.repos) {
      if (!repo.fullName) continue
      result.examined += 1

      const extensionDeadline =
        (repo.userId ? byUser.get(repo.userId) : undefined) ??
        (repo.teamId ? byTeam.get(repo.teamId) : undefined) ??
        null

      const action = decideDeadlineAction(
        {
          assignmentDeadline: assignment.deadline,
          extensionDeadline,
          lockOnDeadline: assignment.lockOnDeadline,
        },
        {
          lockedAt: repo.lockedAt,
          deadlineSha: repo.deadlineSha,
          lastPushedAt: repo.lastPushedAt,
        },
        now,
      )

      if (action.kind === 'none') continue

      const repoName = repo.fullName.split('/')[1]

      try {
        if (action.kind === 'capture' || action.kind === 'capture-and-lock') {
          /*
           * As of the deadline, not as of now.
           *
           * The sweep runs every five minutes, so reading the head recorded whatever
           * happened to be there when we looked: a push at 23:59:30 against a 23:59
           * deadline became the student's submitted commit purely because the sweep
           * had not run yet. Asking GitHub for the commit as of the deadline makes the
           * captured sha identical whether the sweep arrives one second or four
           * minutes late.
           *
           * An unmetered read either way: recording the on-time state costs no
           * content budget.
           */
          const deadline = effectiveDeadline({
            assignmentDeadline: assignment.deadline,
            extensionDeadline,
            lockOnDeadline: assignment.lockOnDeadline,
          })
          const submitted = deadline
            ? await getCommitAsOf(installationId, org, repoName, deadline)
            : null

          // The webhook is what normally maintains lastPushedAt; this fills it in only
          // when no push has ever been seen, rather than spending a second read on
          // every repository.
          const head = repo.lastPushedAt ? null : await getRepoHead(installationId, org, repoName)

          await db.assignmentRepo.update({
            where: { id: repo.id },
            data: {
              // A repository with nothing committed by the deadline records the empty
              // string rather than staying null, so the sweep does not retry it
              // forever.
              deadlineSha: submitted?.sha ?? '',
              ...(head?.committedAt ? { lastPushedAt: new Date(head.committedAt) } : {}),
            },
          })
          result.captured += 1
        }

        if (action.kind === 'lock' || action.kind === 'capture-and-lock') {
          await applyAccess(
            installationId,
            assignment.classroom.id,
            org,
            repoName,
            repo,
            'pull',
          )
          await db.assignmentRepo.update({
            where: { id: repo.id },
            data: { lockedAt: now },
          })
          result.locked += 1
        }

        if (action.kind === 'unlock') {
          await applyAccess(
            installationId,
            assignment.classroom.id,
            org,
            repoName,
            repo,
            toGitHubPermission(assignment.studentPermission),
          )
          await db.assignmentRepo.update({
            where: { id: repo.id },
            data: { lockedAt: null },
          })
          result.unlocked += 1
        }
      } catch (error) {
        result.failed += 1
        const message = error instanceof GitHubDomainError ? error.userMessage : String(error)
        // One repository failing must not abandon the rest of the class, so the
        // loop continues. A rate-limit refusal simply resolves on the next sweep.
        console.warn(`[jobs] deadline action ${action.kind} failed for ${repo.fullName}: ${message}`)
      }
    }
  }

  if (result.captured || result.locked || result.unlocked || result.failed) {
    console.log(
      `[jobs] deadline sweep: examined ${result.examined}, captured ${result.captured}, ` +
        `locked ${result.locked}, unlocked ${result.unlocked}, failed ${result.failed}`,
    )
  }

  return result
}

/**
 * Set a repository's student access, whichever mechanism grants it.
 *
 * Individual repositories use per-repository collaborators; team repositories are
 * reached through the GitHub team, so the team's permission on the repository is
 * what has to change. Getting these two mixed up would silently fail to lock
 * group assignments.
 */
async function applyAccess(
  installationId: bigint,
  classroomId: string,
  org: string,
  repoName: string,
  repo: {
    user: { githubLogin: string | null } | null
    team: { githubTeamSlug: string | null } | null
  },
  permission: 'pull' | 'push' | 'maintain' | 'admin',
): Promise<void> {
  if (repo.team?.githubTeamSlug) {
    await addTeamRepoAccess(
      classroomId,
      installationId,
      org,
      repo.team.githubTeamSlug,
      org,
      repoName,
      permission,
    )
    return
  }

  if (repo.user?.githubLogin) {
    await setCollaboratorPermission(
      installationId,
      org,
      repoName,
      repo.user.githubLogin,
      permission,
    )
  }
}
