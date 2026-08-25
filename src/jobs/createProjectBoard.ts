import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  type BoardCollaborator,
  createLinkedProjectBoard,
  describeBoardFailure,
  projectNodeIdByNumber,
  repositoryNodeId,
  setProjectCollaborators,
  userNodeIds,
} from '@/lib/github/operations/projects'

import type { CreateProjectBoardJob } from './queue'

/**
 * Create an assignment repository's project board, and give people access to it.
 *
 * Two steps, and the second is not optional. A Projects v2 board owned by an
 * organization is private, and one created through an installation token has the App
 * as its only collaborator — so until people are added, *every* human gets a 404,
 * including the organization's owners. GitHub answers 404 rather than 403 for things
 * you cannot see, which makes a board that exists look like one that was never
 * created. That is exactly how this shipped the first time.
 *
 * Both steps are idempotent, so re-running is the repair path: a board recorded
 * without collaborators gets them, and a board that already has them is unchanged.
 *
 * A job rather than part of provisioning, because it is a GitHub write per repository
 * competing for the same 80-per-minute budget as generating the repositories
 * themselves.
 */
export async function createProjectBoard(job: CreateProjectBoardJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      projectUrl: true,
      projectNumber: true,
      failureReason: true,
      user: { select: { githubLogin: true, name: true } },
      team: { select: { name: true, members: { select: { user: { select: { githubLogin: true } } } } } },
      assignment: {
        select: {
          title: true,
          projectBoardEnabled: true,
          classroomId: true,
          classroom: { select: { githubOrgLogin: true, installationId: true } },
        },
      },
    },
  })

  if (!repo || !repo.assignment.projectBoardEnabled || !repo.fullName) return

  const org = repo.assignment.classroom.githubOrgLogin
  const installationId = repo.assignment.classroom.installationId
  const repoName = repo.fullName.split('/')[1]
  const who = repo.team?.name ?? repo.user?.githubLogin ?? repo.user?.name ?? repoName

  try {
    // 1. The board, unless one is already recorded. GitHub will happily create a
    //    second project with the same title, so this must not be retried blindly.
    let projectNumber = repo.projectNumber
    if (!repo.projectUrl) {
      const repoNodeId = await repositoryNodeId(installationId, org, repoName)
      const board = await createLinkedProjectBoard({
        installationId,
        org,
        repoNodeId,
        title: `${repo.assignment.title} — ${who}`,
      })
      projectNumber = board.number
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { projectUrl: board.url, projectNumber: board.number },
      })
      console.log(`[jobs] project board ${board.url} linked to ${repo.fullName}`)
    }

    // 2. Access. Runs whether or not the board was just created, which is what makes
    //    this the repair path for boards that predate this step.
    if (projectNumber !== null) {
      await shareBoard({
        installationId,
        org,
        projectNumber,
        classroomId: repo.assignment.classroomId,
        studentLogins: repo.team
          ? repo.team.members.map((m) => m.user.githubLogin).filter((l): l is string => Boolean(l))
          : [repo.user?.githubLogin].filter((l): l is string => Boolean(l)),
      })
    }

    // Clear a previous board complaint; leave anything else, since the autograding
    // warning shares this column and is not ours to discard.
    if (repo.failureReason?.includes('project board')) {
      await db.assignmentRepo.update({ where: { id: repo.id }, data: { failureReason: null } })
    }
  } catch (error) {
    const raw = (error as Error).message
    const message = error instanceof GitHubDomainError ? error.userMessage : raw
    const note = describeBoardFailure(`${message} ${raw}`)

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

/**
 * Share a board with the people who need it: the student (or the whole team) so they
 * can plan in it, and the classroom's instructors so they can see it.
 *
 * Students get WRITER rather than ADMIN — enough to add, move and close items, not
 * enough to delete the board or change who can see it.
 */
async function shareBoard(input: {
  installationId: bigint
  org: string
  projectNumber: number
  classroomId: string
  studentLogins: readonly string[]
}): Promise<void> {
  const { installationId, org, projectNumber, classroomId, studentLogins } = input

  const projectId = await projectNodeIdByNumber(installationId, org, projectNumber)
  if (!projectId) return

  const instructors = await db.classroomMember.findMany({
    where: { classroomId, role: 'INSTRUCTOR' },
    select: { user: { select: { githubLogin: true } } },
  })
  const instructorLogins = instructors
    .map((m) => m.user.githubLogin)
    .filter((l): l is string => Boolean(l))

  const ids = await userNodeIds(installationId, [...studentLogins, ...instructorLogins])

  const collaborators: BoardCollaborator[] = []
  for (const login of instructorLogins) {
    const id = ids.get(login.toLowerCase())
    if (id) collaborators.push({ userId: id, role: 'ADMIN' })
  }
  for (const login of studentLogins) {
    const id = ids.get(login.toLowerCase())
    // An instructor who is also enrolled keeps the higher role.
    if (id && !collaborators.some((c) => c.userId === id)) {
      collaborators.push({ userId: id, role: 'WRITER' })
    }
  }

  await setProjectCollaborators(installationId, projectId, collaborators)
}
