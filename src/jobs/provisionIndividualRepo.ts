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
  listOrgRepoNames,
} from '@/lib/github/operations/repos'
import { buildRepoName, dedupeRepoName } from '@/lib/github/repoName'

import type { ProvisionIndividualRepoJob } from './queue'

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
          templateOwner: true,
          templateRepo: true,
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
    // 1. Decide the repository name, once, and remember it.
    const repoName = repo.fullName
      ? repo.fullName.split('/')[1]
      : await chooseRepoName(installationId, org, assignment.repoPrefix, repo.id, user.githubLogin)

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
    const { repo: created } =
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

    await db.assignmentRepo.update({
      where: { id: repo.id },
      data: {
        githubRepoId: created.id,
        fullName: created.fullName,
        htmlUrl: created.htmlUrl,
      },
    })

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
      // READY with a note: the repository works, but the instructor needs to know
      // autograding will not run until the underlying problem is fixed.
      data: { status: RepoStatus.READY, failureReason: autogradeWarning },
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
 * Pick an unused repository name.
 *
 * Prefers the student's SIS login id (their NID) over their GitHub login,
 * because it is stable if they rename their GitHub account and it sorts
 * alongside the Canvas roster. Falls back to the GitHub login when the roster
 * has no usable identifier — for instance a name in a non-Latin script, which
 * `buildRepoName` refuses rather than reducing to an empty segment.
 */
async function chooseRepoName(
  installationId: bigint,
  org: string,
  prefix: string,
  assignmentRepoId: string,
  githubLogin: string,
): Promise<string> {
  const rosterEntry = await db.rosterEntry.findFirst({
    where: {
      claimedByUser: { assignmentRepos: { some: { id: assignmentRepoId } } },
    },
    select: { sisLoginId: true },
  })

  const candidates = [rosterEntry?.sisLoginId, githubLogin].filter(
    (v): v is string => Boolean(v),
  )

  let base: string | null = null
  for (const candidate of candidates) {
    try {
      base = buildRepoName({ prefix, identifier: candidate })
      break
    } catch {
      // Nothing GitHub permits survived sanitisation; try the next candidate.
    }
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
