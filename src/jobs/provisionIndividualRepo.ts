import 'server-only'

import { RepoStatus } from '@prisma/client'

import { injectAutogradingWorkflow } from '@/lib/autograding/inject'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { addCollaborator, toGitHubPermission } from '@/lib/github/operations/collaborators'
import { ensureFeedbackBranch } from '@/lib/github/operations/pulls'
import {
  createEmptyRepo,
  generateRepoFromTemplate,
  getRepo,
  listOrgRepoNames,
} from '@/lib/github/operations/repos'
import { buildRepoName, dedupeRepoName } from '@/lib/github/repoName'

import { ProvisionIndividualRepoJob, QUEUES, enqueue } from './queue'

/**
 * Provision one student's repository for an individual assignment.
 *
 * Every step is idempotent and the row records progress as it goes, because this
 * job **will** be interrupted: by a rate-limit refusal, a worker restart, or a
 * GitHub 5xx. A retry must converge on the same repository rather than create a
 * second one or fail permanently.
 *
 * The order matters. The repository name is decided and persisted *before* the
 * repository is created, so a crash between the two leaves a name we can look up
 * again instead of generating a fresh one and orphaning the first.
 */
export async function provisionIndividualRepo(
  job: ProvisionIndividualRepoJob,
): Promise<void> {
  const repo = await db.assignmentRepo.findUnique({
    where: { id: job.assignmentRepoId },
    select: {
      id: true,
      status: true,
      fullName: true,
      githubRepoId: true,
      feedbackPrNumber: true,
      userId: true,
      assignment: {
        select: {
          id: true,
          repoPrefix: true,
          repoSource: true,
          title: true,
          templateOwner: true,
          templateRepo: true,
          projectBoardEnabled: true,
          visibility: true,
          studentPermission: true,
          feedbackPrEnabled: true,
          autogradeEnabled: true,
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
            select: {
              id: true,
              githubOrgLogin: true,
              installationId: true,
            },
          },
        },
      },
      user: { select: { id: true, githubLogin: true } },
      projectUrl: true,
    },
  })

  if (!repo) {
    // The assignment or student was deleted while the job waited. Not an error.
    console.warn(`[jobs] assignmentRepo ${job.assignmentRepoId} no longer exists; skipping`)
    return
  }

  if (repo.status === RepoStatus.READY) return

  const { assignment, user } = repo
  const { classroom } = assignment
  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId

  if (!user?.githubLogin) {
    await markFailed(
      repo.id,
      'This student has no linked GitHub account, so no repository can be created for them. ' +
        'Ask them to sign in and claim their roster entry.',
    )
    return
  }

  await db.assignmentRepo.update({
    where: { id: repo.id },
    data: { status: RepoStatus.PROVISIONING, failureReason: null },
  })

  let autogradeWarning: string | null = null

  try {
    // 1 and 2. The repository — created, or adopted.
    let repoName: string
    let created: { id: bigint; fullName: string; htmlUrl: string }

    if (assignment.repoSource === 'EXISTING') {
      /*
       * Adopting a repository that already exists.
       *
       * `fullName` here is the instructor's input rather than a resume marker: the
       * assign action wrote it and verified it then. Re-verified anyway, because the
       * repository can be renamed, deleted or transferred in between, and every step
       * below would otherwise fail one at a time with a 404 that explains nothing.
       *
       * Never falls back to creating one — see the note in provisionTeamRepo. It
       * matters slightly more here, because a repository may be deliberately shared
       * by several students and a silent creation would quietly un-share it for one
       * of them.
       */
      if (!repo.fullName) {
        await markFailed(
          repo.id,
          'No repository has been assigned to this student yet. Assign one from the ' +
            'assignment\u2019s Repositories tab.',
        )
        return
      }

      const [linkedOwner, linkedName] = repo.fullName.split('/')
      const found = await getRepo(installationId, linkedOwner, linkedName)
      if (!found) {
        await markFailed(
          repo.id,
          `${repo.fullName} no longer exists, or this app can no longer see it. Check the ` +
            'repository on GitHub and assign it again.',
        )
        return
      }

      repoName = linkedName
      created = { id: found.id, fullName: found.fullName, htmlUrl: found.htmlUrl }

      // Visibility is deliberately left alone; the repository already has a history
      // and an audience. Same reasoning as the team path.
      await db.assignmentRepo.update({
        where: { id: repo.id },
        data: { githubRepoId: found.id, fullName: found.fullName, htmlUrl: found.htmlUrl },
      })
    } else {
      // 1. Decide the repository name, once, and remember it.
      repoName = repo.fullName
        ? repo.fullName.split('/')[1]
        : await chooseRepoName(
            installationId,
            org,
            assignment.repoPrefix,
            repo.id,
            user.githubLogin,
          )

      if (!repo.fullName) {
        await db.assignmentRepo.update({
          where: { id: repo.id },
          data: { fullName: `${org}/${repoName}` },
        })
      }

      /*
       * 2. Create the repository. From a template when the assignment has one —
       *    which waits for GitHub's asynchronous copy so later steps can rely on
       *    the contents existing — or empty when it does not.
       *
       *    An assignment without a template is not a degraded case: "build this from
       *    scratch" is a normal thing to set, and the empty repository is the
       *    starting state. Everything downstream already copes; see createEmptyRepo.
       */
      const generated =
        assignment.templateOwner && assignment.templateRepo
          ? await generateRepoFromTemplate({
              installationId,
              templateOwner: assignment.templateOwner,
              templateRepo: assignment.templateRepo,
              owner: org,
              name: repoName,
              private: assignment.visibility === 'PRIVATE',
              description: `Assignment repository for ${user.githubLogin}`,
            })
          : await createEmptyRepo({
              installationId,
              owner: org,
              name: repoName,
              private: assignment.visibility === 'PRIVATE',
              description: `Assignment repository for ${user.githubLogin}`,
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

    // 3. Give the student access. Returns an invitation they must accept when
    //    they are not already an org member.
    const access = await addCollaborator(
      installationId,
      org,
      repoName,
      user.githubLogin,
      toGitHubPermission(assignment.studentPermission),
    )

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        invitationId: access.state === 'invited' ? access.invitationId : null,
      },
    })


    /*
     * Project board, when the assignment wants one — queued, not created here.
     *
     * It is a GitHub write per repository, competing for the same 80-per-minute
     * budget as generating the repository itself, so creating it inline would make a
     * whole class accepting at once push provisioning over the limit. Queuing also
     * makes it recoverable: an assignment that has boards switched on afterwards is
     * one enqueue per repository away from being correct, with no second
     * implementation of the same thing.
     */
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

    // Autograding workflow. Written after the repository exists and before the
    // feedback PR, so the injected commits are part of the starting state rather
    // than appearing as student work in the feedback diff.
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
     * 4. Pin the feedback baseline.
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

    await db.assignmentRepo.update({
      where: { id: repo.id },
      /*
       * READY with a note: the repository works, but the instructor needs to know
       * that autograding will not run, or that no board was created, until the
       * underlying problem is fixed.
       *
       * Both warnings are joined rather than one overwriting the other — a missing
       * `Projects: write` permission and a broken autograding workflow have different
       * fixes, and seeing only one of them sends you to fix the wrong thing.
       */
      data: {
        status: RepoStatus.READY,
        failureReason: autogradeWarning,
      },
    })
  } catch (error) {
    if (error instanceof GitHubDomainError) {
      if (error.retryable) {
        // Put the row back to QUEUED so the UI shows "waiting", not "failed",
        // then rethrow so pg-boss schedules the retry.
        await db.assignmentRepo.update({
          where: { id: repo.id },
          data: { status: RepoStatus.QUEUED, failureReason: error.userMessage },
        })
        throw error
      }

      await markFailed(repo.id, error.userMessage)
      // Swallowed deliberately: a permanent failure is recorded on the row for
      // the instructor to act on, and retrying it would only waste attempts.
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

/**
 * Pick an unused repository name, from the student's GitHub login and nothing else.
 *
 * This used to prefer the SIS login id — a UCF NID — because it is stable when a
 * student renames their GitHub account and it sorts alongside the Canvas roster.
 * Both of those are true, and neither is worth the cost: a repository name is visible
 * to everyone who can see the organization, and it propagates into clone URLs, Actions
 * logs, commit metadata, and any link a student pastes into a ticket or a chat. An NID
 * is restricted student information and does not belong in any of those places.
 *
 * The GitHub login always survives sanitisation — GitHub itself only permits ASCII
 * letters, digits and hyphens in a username — so the fallback below is unreachable in
 * practice. It stays so that a future change to that assumption degrades into an ugly
 * repository name rather than a failed provisioning job.
 */
async function chooseRepoName(
  installationId: bigint,
  org: string,
  prefix: string,
  assignmentRepoId: string,
  githubLogin: string,
): Promise<string> {
  let base: string | null = null
  try {
    base = buildRepoName({ prefix, identifier: githubLogin })
  } catch {
    base = null
  }

  if (!base) {
    // Last resort so provisioning never hard-fails on an unrepresentable name.
    base = buildRepoName({ prefix, identifier: `student-${assignmentRepoId.slice(-8)}` })
  }

  // Compare against names actually on GitHub, not just our own records: a repo
  // left over from a previous term would otherwise collide at creation time.
  const taken = await listOrgRepoNames(installationId, org)
  return dedupeRepoName(base, taken)
}
