'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { enqueue, QUEUES } from '@/jobs/queue'
import { injectAutogradingWorkflow } from '@/lib/autograding/inject'
import { resyncAutogradeRuns } from '@/jobs/ingestAutogradeRun'

export type AutogradeActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const testSchema = z.object({
  name: z.string().trim().min(1, 'Each test needs a name.').max(200),
  setupCommand: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : null)),
  runCommand: z.string().trim().min(1, 'Each test needs a command to run.').max(2000),
  timeoutMinutes: z.coerce.number().int().min(1).max(60),
  points: z.coerce.number().int().min(0).max(10_000),
})

/**
 * Replace an assignment's grading tests.
 *
 * Sent and stored as a whole list rather than edited row by row: ordering and
 * point totals only make sense as a set, and a partial save could leave an
 * assignment whose points do not add up to what students were told.
 */
export async function saveGradingTests(
  formData: FormData,
): Promise<AutogradeActionResult<{ injected: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const rawTests = String(formData.get('tests') ?? '[]')
  const autogradeEnabled = formData.get('autogradeEnabled') === 'on'

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      classroomId: true,
      classroom: { select: { slug: true, githubOrgLogin: true, installationId: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  let parsedInput: unknown
  try {
    parsedInput = JSON.parse(rawTests)
  } catch {
    return { ok: false, error: 'The test list could not be read. Reload and try again.' }
  }

  const parsed = z.array(testSchema).max(50).safeParse(parsedInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'One of the tests is not valid.',
    }
  }

  const tests = parsed.data

  // Duplicate names would collide when reconciling a run against the config, and
  // would read ambiguously in a Canvas export.
  const names = new Set<string>()
  for (const test of tests) {
    if (names.has(test.name)) {
      return { ok: false, error: `Two tests are both called “${test.name}”. Names must differ.` }
    }
    names.add(test.name)
  }

  const totalPoints = tests.reduce((sum, t) => sum + t.points, 0)

  await db.$transaction([
    db.gradingTest.deleteMany({ where: { assignmentId } }),
    ...(tests.length > 0
      ? [
          db.gradingTest.createMany({
            data: tests.map((test, index) => ({
              assignmentId,
              name: test.name,
              setupCommand: test.setupCommand,
              runCommand: test.runCommand,
              timeoutMinutes: test.timeoutMinutes,
              points: test.points,
              order: index,
            })),
          }),
        ]
      : []),
    db.assignment.update({
      where: { id: assignmentId },
      data: { autogradeEnabled, totalPoints },
    }),
  ])

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'autograding.configure',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: {
        title: assignment.title,
        enabled: autogradeEnabled,
        testCount: tests.length,
        totalPoints,
      },
    },
  })

  // Push the new workflow to every existing repository, so students are graded
  // against the current tests rather than whatever was current when their
  // repository was created.
  let injected = 0
  if (autogradeEnabled) {
    const repos = await db.assignmentRepo.findMany({
      where: { assignmentId, status: 'READY', fullName: { not: null } },
      select: { fullName: true },
    })

    const specs = tests.map((test, index) => ({
      id: `gt_${index}`,
      name: test.name,
      setupCommand: test.setupCommand,
      runCommand: test.runCommand,
      timeoutMinutes: test.timeoutMinutes,
      points: test.points,
    }))

    for (const repo of repos) {
      try {
        await injectAutogradingWorkflow({
          installationId: assignment.classroom.installationId,
          owner: assignment.classroom.githubOrgLogin,
          repo: repo.fullName!.split('/')[1],
          tests: specs,
        })
        injected += 1
      } catch (error) {
        // One repository failing must not abandon the rest; the instructor can
        // retry from this page.
        console.warn(`[autograding] could not update ${repo.fullName}: ${String(error)}`)
      }
    }
  }

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { injected } }
}

/**
 * Re-scan recent workflow runs for every repository in an assignment.
 *
 * The recovery path for missed webhooks — the app was down, the forwarding tunnel
 * was closed, or the webhook was not configured when students pushed.
 */
export async function resyncAssignmentGrades(
  formData: FormData,
): Promise<AutogradeActionResult<{ examined: number; queued: number; repos: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      autogradeEnabled: true,
      classroomId: true,
      classroom: { select: { slug: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  if (!assignment.autogradeEnabled) {
    return { ok: false, error: 'Autograding is not enabled for this assignment.' }
  }

  const repos = await db.assignmentRepo.findMany({
    where: { assignmentId, status: 'READY', githubRepoId: { not: null } },
    select: { id: true },
  })

  let examined = 0
  let queued = 0
  for (const repo of repos) {
    try {
      const result = await resyncAutogradeRuns(repo.id)
      examined += result.examined
      queued += result.queued
    } catch (error) {
      console.warn(`[autograding] resync failed for repo ${repo.id}: ${String(error)}`)
    }
  }

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'autograding.resync',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { title: assignment.title, repos: repos.length, examined, queued },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { examined, queued, repos: repos.length } }
}

/** Re-push the workflow to a single repository, for a one-off fix. */
export async function reinjectWorkflow(
  formData: FormData,
): Promise<AutogradeActionResult> {
  const assignmentRepoId = String(formData.get('assignmentRepoId') ?? '')

  const repo = await db.assignmentRepo.findUnique({
    where: { id: assignmentRepoId },
    select: {
      fullName: true,
      assignment: {
        select: {
          id: true,
          classroomId: true,
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
            select: { slug: true, githubOrgLogin: true, installationId: true },
          },
        },
      },
    },
  })
  if (!repo?.fullName) return { ok: false, error: 'That repository does not exist on GitHub yet.' }

  await requireInstructor(repo.assignment.classroomId)

  try {
    await injectAutogradingWorkflow({
      installationId: repo.assignment.classroom.installationId,
      owner: repo.assignment.classroom.githubOrgLogin,
      repo: repo.fullName.split('/')[1],
      tests: repo.assignment.gradingTests,
    })
  } catch (error) {
    return {
      ok: false,
      error: `The workflow could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  revalidatePath(
    `/classrooms/${repo.assignment.classroom.slug}/assignments/${repo.assignment.id}`,
  )
  return { ok: true, data: undefined }
}

/** Queue ingestion for a specific run, used by the per-repo re-check button. */
export async function ingestRunNow(formData: FormData): Promise<AutogradeActionResult> {
  const assignmentRepoId = String(formData.get('assignmentRepoId') ?? '')

  const repo = await db.assignmentRepo.findUnique({
    where: { id: assignmentRepoId },
    select: { githubRepoId: true, assignment: { select: { classroomId: true } } },
  })
  if (!repo?.githubRepoId) return { ok: false, error: 'That repository has no GitHub id yet.' }

  await requireInstructor(repo.assignment.classroomId)

  const result = await resyncAutogradeRuns(assignmentRepoId)
  if (result.queued === 0) {
    return {
      ok: false,
      error:
        result.examined === 0
          ? 'No completed workflow runs were found for this repository yet.'
          : 'Every completed run has already been graded.',
    }
  }

  await enqueue(QUEUES.enforceDeadlines, {}, { singletonKey: 'deadline-sweep-adhoc' })
  return { ok: true, data: undefined }
}
