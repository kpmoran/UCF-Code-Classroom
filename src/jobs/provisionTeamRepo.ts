import 'server-only'

import { RepoStatus } from '@prisma/client'

import { injectAutogradingWorkflow } from '@/lib/autograding/inject'
import {
  createLinkedProjectBoard,
  describeBoardFailure,
  repositoryNodeId,
} from '@/lib/github/operations/projects'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { toGitHubPermission } from '@/lib/github/operations/collaborators'
import { ensureFeedbackBranch } from '@/lib/github/operations/pulls'
import {
  createEmptyRepo,
  generateRepoFromTemplate,
  listOrgRepoNames,
} from '@/lib/github/operations/repos'
import {
  addTeamMembership,
  addTeamRepoAccess,
  createTeam,
} from '@/lib/github/operations/teams'
import { buildTeamRepoName, dedupeRepoName, slugifyTeamName } from '@/lib/github/repoName'

import type { ProvisionTeamRepoJob } from './queue'

/**
 * Provision a team's repository for a group assignment.
 *
 * Longer than the individual path because access is granted through a GitHub
 * team rather than per-repository collaborators, which means four resources have
 * to converge: the GitHub team, its memberships, the repository, and the team's
 * permission on that repository.
 *
 * Every step is idempotent and progress is recorded as it goes, and the order is
 * chosen so an interruption is always resumable:
 *
 *   1. GitHub team          (looked up by slug before creating)
 *   2. Memberships          (upsert; pending until the student accepts)
 *   3. Repository           (name persisted before creation)
 *   4. Team → repo access   (GitHub upserts)
 *   5. Feedback PR          (optional, never fatal)
 *
 * Re-running this is also how a **late joiner** is added: the job is re-enqueued
 * when membership changes, and steps 1, 3 and 4 no-op while step 2 adds the new
 * member.
 */
export async function provisionTeamRepo(job: ProvisionTeamRepoJob): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      status: true,
      fullName: true,
      feedbackPrNumber: true,
      projectUrl: true,
      teamId: true,
      assignment: {
        select: {
          id: true,
          title: true,
          repoPrefix: true,
          templateOwner: true,
          templateRepo: true,
          visibility: true,
          studentPermission: true,
          feedbackPrEnabled: true,
          autogradeEnabled: true,
          projectBoardEnabled: true,
          gradingTests: {
            select: {
              id: true,
              name: true,
              setupCommand: true,
              runCommand: true,
              timeoutMinutes: true,
              points: true,
            },
            orderBy: { order: 'asc' },
          },
          classroom: {
            select: { id: true, githubOrgLogin: true, installationId: true },
          },
        },
      },
      team: {
        select: {
          id: true,
          name: true,
          githubTeamSlug: true,
          members: {
            select: {
              id: true,
              githubMembershipState: true,
              user: { select: { id: true, githubLogin: true } },
            },
          },
        },
      },
    },
  })

  if (!repo) {
    console.warn(`[jobs] assignmentRepo ${job.assignmentRepoId} no longer exists; skipping`)
    return
  }

  const { assignment, team } = repo
  if (!team) {
    await markFailed(repo.id, 'This repository is not linked to a team.')
    return
  }

  const { classroom } = assignment
  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId
  const classroomId = classroom.id

  const membersWithLogin = team.members.filter((m) => m.user.githubLogin)
  const membersMissingLogin = team.members.length - membersWithLogin.length

  if (membersWithLogin.length === 0) {
    await markFailed(
      repo.id,
      'No member of this team has a linked GitHub account yet, so no repository can be ' +
        'created. Ask them to sign in and claim their roster entry.',
    )
    return
  }

  await db.assignmentRepo.update({
    where: { id: repo.id },
    data: { status: RepoStatus.PROVISIONING, failureReason: null },
  })

  let autogradeWarning: string | null = null
  let boardWarning: string | null = null

  try {
    // 1. The GitHub team. Named for the assignment so several assignments in one
    //    org do not collide on a team called "The Knights".
    const githubTeamName = `${assignment.repoPrefix}-${team.name}`
    const { team: githubTeam } = await createTeam(
      classroomId,
      installationId,
      org,
      githubTeamName,
      `${team.name} — ${assignment.title}`,
    )

    await db.team.update({
      where: { id: team.id },
      data: { githubTeamId: githubTeam.id, githubTeamSlug: githubTeam.slug },
    })

    // 2. Memberships. A student who has not accepted GitHub's invitation stays
    //    `pending` and cannot push, so the state is recorded for the UI rather
    //    than treated as done.
    for (const member of membersWithLogin) {
      const result = await addTeamMembership(
        classroomId,
        installationId,
        org,
        githubTeam.slug,
        member.user.githubLogin!,
      )
      await db.teamMember.update({
        where: { id: member.id },
        data: { githubMembershipState: result.state },
      })
    }

    // 3. The repository. Name persisted first, so a crash resumes rather than
    //    generating a second one.
    const repoName = repo.fullName
      ? repo.fullName.split('/')[1]
      : dedupeRepoName(
          buildTeamRepoName(assignment.repoPrefix, team.name),
          await listOrgRepoNames(installationId, org),
        )

    if (!repo.fullName) {
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { fullName: `${org}/${repoName}` },
      })
    }

    // From a template when there is one, otherwise empty — see createEmptyRepo.
    const { repo: created } =
      assignment.templateOwner && assignment.templateRepo
        ? await generateRepoFromTemplate({
            installationId,
            templateOwner: assignment.templateOwner,
            templateRepo: assignment.templateRepo,
            owner: org,
            name: repoName,
            private: assignment.visibility === 'PRIVATE',
            description: `${team.name} — ${assignment.title}`,
          })
        : await createEmptyRepo({
            installationId,
            owner: org,
            name: repoName,
            private: assignment.visibility === 'PRIVATE',
            description: `${team.name} — ${assignment.title}`,
          })

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        githubRepoId: created.id,
        fullName: created.fullName,
        htmlUrl: created.htmlUrl,
      },
    })

    // 4. Give the team access to the repository.
    await addTeamRepoAccess(
      classroomId,
      installationId,
      org,
      githubTeam.slug,
      org,
      repoName,
      toGitHubPermission(assignment.studentPermission),
    )


    // Autograding workflow. Written after the repository exists and before the
    // feedback PR, so the injected commits are part of the starting state rather
    // than appearing as student work in the feedback diff.
    /*
     * One board per team, mirroring the individual path — organization-owned,
     * because GitHub only links a project to a repository owned by the same account.
     * Skipped when one is already recorded: a retry must attach the existing board
     * rather than create a second identically titled one.
     */
    if (assignment.projectBoardEnabled && !repo.projectUrl) {
      try {
        const repoNodeId = await repositoryNodeId(installationId, org, repoName)
        const board = await createLinkedProjectBoard({
          installationId,
          org,
          repoNodeId,
          title: `${assignment.title} — ${team.name}`,
        })
        await db.assignmentRepo.update({
          where: { id: repo.id },
          data: { projectUrl: board.url, projectNumber: board.number },
        })
      } catch (error) {
        // Both forms checked: GitHubDomainError rewrites some messages, and the
        // permission text can arrive in either one.
        const raw = (error as Error).message
        const message = error instanceof GitHubDomainError ? error.userMessage : raw
        boardWarning = describeBoardFailure(`${message} ${raw}`)
      }
    }

    if (assignment.autogradeEnabled) {
      try {
        const injected = await injectAutogradingWorkflow({
          installationId,
          owner: org,
          repo: repoName,
          tests: assignment.gradingTests,
        })
        if (injected.workflowChanged || injected.manifestChanged) {
          console.log(`[jobs] autograding workflow written to ${created.fullName}`)
        }
      } catch (error) {
        /**
         * Not fatal — the student has a working repository — but it must not be
         * silent either. A swallowed failure here means autograding never runs and
         * nobody finds out until grades are due, so the reason is recorded on the
         * row where the instructor will see it.
         */
        const reason =
          error instanceof GitHubDomainError
            ? error.userMessage
            : 'The autograding workflow could not be written to this repository.'

        console.warn(
          `[jobs] could not write autograding workflow to ${created.fullName}: ${reason}`,
        )
        autogradeWarning = reason
      }
    }

    /**
     * 5. Pin the feedback baseline.
     *
     * Runs *after* the autograding injection so the branch sits at the state this
     * app produced, not the template's first commit — otherwise our own workflow
     * and manifest files would show up as student changes in every feedback diff.
     *
     * The pull request itself is not opened here: GitHub refuses one with no
     * commits between base and head, and the student has pushed nothing yet. It is
     * opened by the `ensure-feedback-pr` job on their first push.
     */
    if (assignment.feedbackPrEnabled && repo.feedbackPrNumber === null) {
      try {
        const baseline = await ensureFeedbackBranch(installationId, org, repoName)
        if (baseline.state === 'skipped') {
          console.warn(`[jobs] no feedback baseline for ${created.fullName}: ${baseline.reason}`)
        }
      } catch (error) {
        // Not fatal: the student has a working repository, and the sweep will try
        // again.
        console.warn(
          `[jobs] feedback baseline for ${created.fullName} could not be pinned: ${String(error)}`,
        )
      }
    }

    // Members without a GitHub account are recorded as a warning rather than a
    // failure: the rest of the team can work, and the gap is actionable.
    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        status: RepoStatus.READY,
        failureReason:
          [autogradeWarning, boardWarning].filter(Boolean).join(' ') ||
          (membersMissingLogin > 0
            ? membersMissingLogin === 1
              ? '1 team member has not linked a GitHub account, so they have no access yet.'
              : `${membersMissingLogin} team members have not linked a GitHub account, so ` +
                'they have no access yet.'
            : null),
      },
    })
  } catch (error) {
    if (error instanceof GitHubDomainError) {
      if (error.retryable) {
        await db.assignmentRepo.update({
          where: { id: repo.id },
          data: { status: RepoStatus.QUEUED, failureReason: error.userMessage },
        })
        throw error
      }

      await markFailed(repo.id, error.userMessage)
      return
    }

    await markFailed(
      repo.id,
      error instanceof Error ? error.message : 'An unexpected error occurred.',
    )
    throw error
  }
}

async function markFailed(assignmentRepoId: string, reason: string): Promise<void> {
  await db.assignmentRepo.update({
    where: { id: assignmentRepoId },
    data: { status: RepoStatus.FAILED, failureReason: reason },
  })
}

export { slugifyTeamName }
