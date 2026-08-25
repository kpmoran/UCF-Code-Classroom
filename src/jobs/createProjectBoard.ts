import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  createLinkedProjectBoard,
  describeBoardFailure,
  repositoryNodeId,
} from '@/lib/github/operations/projects'

import type { CreateProjectBoardJob } from './queue'

/**
 * Create the project board for one assignment repository, and link it.
 *
 * A job rather than part of provisioning, for the same reason feedback pull requests
 * are: it is a GitHub write per student, competing for the same 80-per-minute
 * secondary limit as repository creation, and a whole class arriving at once would
 * otherwise push provisioning over the edge. It also makes the board recoverable —
 * an assignment whose repositories already exist, or which had boards switched on
 * afterwards, is one enqueue per repository away from being correct.
 *
 * Boards are owned by the organization, never by the student. GitHub only lists
 * projects owned by the same account that owns the repository, so a student's own
 * board can never be linked to an assignment repository.
 */
export async function createProjectBoard(job: CreateProjectBoardJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      projectUrl: true,
      failureReason: true,
      user: { select: { githubLogin: true, name: true } },
      team: { select: { name: true } },
      assignment: {
        select: {
          title: true,
          projectBoardEnabled: true,
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  // Deleted, already has one, or the assignment no longer wants boards. All three are
  // ordinary outcomes for a job that may have been queued minutes ago.
  if (!repo || repo.projectUrl || !repo.assignment.projectBoardEnabled) return
  if (!repo.fullName) return

  const org = repo.assignment.classroom.githubOrgLogin
  const installationId = repo.assignment.classroom.installationId
  const repoName = repo.fullName.split('/')[1]

  // The team's name for group work, the student's login otherwise — the same thing
  // that names the repository, so a board is findable from either direction.
  const who = repo.team?.name ?? repo.user?.githubLogin ?? repo.user?.name ?? repoName

  try {
    const repoNodeId = await repositoryNodeId(installationId, org, repoName)
    const board = await createLinkedProjectBoard({
      installationId,
      org,
      repoNodeId,
      title: `${repo.assignment.title} — ${who}`,
    })

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        projectUrl: board.url,
        projectNumber: board.number,
        // Clear a previous board failure; leave any other note alone, because the
        // autograding warning lives in this column too and is not ours to discard.
        failureReason: repo.failureReason?.includes('project board')
          ? null
          : repo.failureReason,
      },
    })
    console.log(`[jobs] project board ${board.url} linked to ${repo.fullName}`)
  } catch (error) {
    const raw = (error as Error).message
    const message = error instanceof GitHubDomainError ? error.userMessage : raw
    const note = describeBoardFailure(`${message} ${raw}`)

    // Recorded rather than thrown. The repository works; a missing board is a gap the
    // instructor can act on, not a reason to mark provisioning failed.
    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        failureReason: repo.failureReason?.includes('project board')
          ? note
          : [repo.failureReason, note].filter(Boolean).join(' '),
      },
    })
    console.warn(`[jobs] project board failed for ${repo.fullName}: ${raw}`)
  }
}
