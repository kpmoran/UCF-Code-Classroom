import 'server-only'

import { RepoStatus } from '@prisma/client'

import { injectAutogradingWorkflow } from '@/lib/autograding/inject'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { toGitHubPermission } from '@/lib/github/operations/collaborators'
import { ensureFeedbackBranch } from '@/lib/github/operations/pulls'
import {
  createEmptyRepo,
  generateRepoFromTemplate,
  getRepo,
  listOrgRepoNames,
} from '@/lib/github/operations/repos'
import {
  addTeamMembership,
  addTeamRepoAccess,
  createTeam,
} from '@/lib/github/operations/teams'
import { buildTeamRepoName, dedupeRepoName, slugifyTeamName } from '@/lib/github/repoName'

import { ProvisionTeamRepoJob, QUEUES, enqueue } from './queue'

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
 *   3. Repository           (created, or adopted — see below)
 *   4. Team → repo access   (GitHub upserts)
 *   5. Feedback PR          (optional, never fatal)
 *
 * Step 3 is the only one that differs between the two `repoSource` modes. Under
 * CREATE the repository is generated from the template or created empty; under
 * EXISTING it was linked by an instructor beforehand and is merely verified. Every
 * step after it operates on `owner/name` and does not care which way it got there.
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
          repoSource: true,
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
  /*
   * The commit the autograding injection produced, carried to the feedback baseline
   * below so it is pinned at exactly that commit rather than at whatever a fresh read
   * of the branch head happens to return. See ensureFeedbackBranch for why that read
   * cannot be trusted immediately after a write.
   */
  let injectedSha: string | null = null

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

    // 3. The repository — created, or adopted.
    let repoName: string
    let created: { id: bigint; fullName: string; htmlUrl: string }

    if (assignment.repoSource === 'EXISTING') {
      /*
       * Adopting a repository that already exists.
       *
       * `fullName` is not a resume marker here, it is the instructor's input: the
       * link action wrote it and verified the repository then. Re-verified anyway,
       * because the repository can be renamed, deleted or transferred between the
       * link and this job, and every step below would otherwise fail one at a time
       * with a 404 that says nothing about the cause.
       *
       * Never falls back to creating one. A repository conjured out of a typo is
       * the failure this whole mode exists to avoid: it would look provisioned,
       * collect the workflow and the team, and be empty at the deadline.
       */
      if (!repo.fullName) {
        await markFailed(
          repo.id,
          'No repository has been linked to this team yet. Link the team\u2019s existing ' +
            'repository from the Teams panel.',
        )
        return
      }

      const [linkedOwner, linkedName] = repo.fullName.split('/')
      const found = await getRepo(installationId, linkedOwner, linkedName)
      if (!found) {
        await markFailed(
          repo.id,
          `${repo.fullName} no longer exists, or this app can no longer see it. Check the ` +
            'repository on GitHub and link it again.',
        )
        return
      }

      repoName = linkedName
      created = { id: found.id, fullName: found.fullName, htmlUrl: found.htmlUrl }

      /*
       * Visibility is deliberately left alone. Under CREATE the assignment's setting
       * describes a repository this app is making; here it describes one that already
       * has a history and an audience, and flipping a public project private — or the
       * reverse — is not a side effect to bury in a provisioning job.
       */
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { githubRepoId: found.id, fullName: found.fullName, htmlUrl: found.htmlUrl },
      })
    } else {
      // Name persisted first, so a crash resumes rather than generating a second one.
      repoName = repo.fullName
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
      const generated =
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

      created = {
        id: generated.repo.id,
        fullName: generated.repo.fullName,
        htmlUrl: generated.repo.htmlUrl,
      }

      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: {
          githubRepoId: created.id,
          fullName: created.fullName,
          htmlUrl: created.htmlUrl,
        },
      })
    }

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
    // One board per team, mirroring the individual path — queued for the same
    // reason: it is a GitHub write per repository against a shared rate budget.
    if (assignment.projectBoardEnabled && !repo.projectUrl) {
      await enqueue(
        QUEUES.createProjectBoard,
        { assignmentRepoId: repo.id },
        /*
         * Deliberately delayed. Provisioning one repository spends most of a minute's
         * content budget, so a board job starting immediately is refused by our own
         * limiter almost every time. Retries would recover it, but a minute's wait
         * avoids the failed attempt entirely.
         */
        { singletonKey: `board:${repo.id}`, startAfterSeconds: 60 },
      )

    }

    /*
     * Staff access to the new repository. Outside the project-board branch on
     * purpose — the first version of this nested it there, which quietly meant
     * staff got access only to assignments that happened to have boards on.
     *
     * Queued rather than done inline for the same reason as the board: one more
     * GitHub write per repository against the same content budget, which would
     * otherwise be spent during the burst when a whole class accepts at once.
     *
     * A no-op until someone sets up the classroom's staff team, so this costs
     * nothing for a classroom that has not asked for it.
     */
    await enqueue(
      QUEUES.grantStaffRepoAccess,
      { assignmentRepoId: repo.id },
      { singletonKey: `staff:${repo.id}`, startAfterSeconds: 90 },
    )

    if (assignment.autogradeEnabled) {
      try {
        const injected = await injectAutogradingWorkflow({
          installationId,
          owner: org,
          repo: repoName,
          tests: assignment.gradingTests,
        })
        injectedSha = injected.commitSha
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
        const baseline = await ensureFeedbackBranch(
          installationId,
          org,
          repoName,
          injectedSha,
        )
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
          autogradeWarning ??
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
