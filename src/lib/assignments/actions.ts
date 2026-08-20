'use server'

import { RepoStatus } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireClassroomRole, requireInstructor, requireUser } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { listTemplateRepos, validateTemplate } from '@/lib/github/operations/repos'
import { estimateProvisioningMs, formatDuration } from '@/lib/github/rateLimiter'
import { enqueue, enqueueMany, QUEUES } from '@/jobs/queue'
import { buildClassroomSlug, dedupeSlug } from '@/lib/slug'

import { callsPerRepo } from './estimate'
import {
  createAssignmentSchema,
  parseDeadline,
  parseTemplateReference,
  type AssignmentActionResult,
} from './schemas'

/**
 * The organization's template repositories, for the picker on the new-assignment form.
 *
 * A separate round trip on purpose. Fetching this during the page render made
 * navigating to the form roughly ten times slower than the page it is reached from
 * (~280ms against ~20ms locally, and the GitHub call was all of it) — and because
 * the button is a client-side navigation with nothing to show meanwhile, the browser
 * sat on the previous page for the whole wait, which reads as a dead click rather
 * than as loading.
 *
 * The suggestions were never load-bearing: the field accepts any `owner/repo` as free
 * text, so the form is completely usable before this resolves. Blocking first paint on
 * a convenience was the mistake.
 */
export async function getTemplateSuggestions(
  classroomId: string,
): Promise<Array<{ fullName: string; name: string }>> {
  // Same authorization as creating the assignment: this reveals private repository
  // names, so it cannot be looser than the form it serves.
  const { classroom } = await requireInstructor(classroomId)

  try {
    const templates = await listTemplateRepos(classroom.installationId, classroom.githubOrgLogin)
    return templates.map((t) => ({ fullName: t.fullName, name: t.name }))
  } catch {
    // An empty list degrades to a plain text field, which is the documented
    // fallback. A GitHub outage must not stop an assignment being created.
    return []
  }
}

export async function createAssignment(
  formData: FormData,
): Promise<AssignmentActionResult<never>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  const parsed = createAssignmentSchema.safeParse({
    classroomId,
    title: formData.get('title'),
    type: formData.get('type'),
    template: formData.get('template'),
    repoPrefix: formData.get('repoPrefix'),
    visibility: formData.get('visibility'),
    studentPermission: formData.get('studentPermission'),
    deadline: formData.get('deadline') ?? undefined,
    lockOnDeadline: formData.get('lockOnDeadline') === 'on',
    feedbackPrEnabled: formData.get('feedbackPrEnabled') === 'on',
    autogradeEnabled: formData.get('autogradeEnabled') === 'on',
    maxTeams: formData.get('maxTeams') || undefined,
    maxTeamSize: formData.get('maxTeamSize') || undefined,
    publish: formData.get('publish') === 'on',
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] ??= issue.message
    }
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const input = parsed.data

  if (classroom.archivedAt) {
    return { ok: false, error: 'This classroom is archived. Restore it before adding assignments.' }
  }

  const deadline = parseDeadline(input.deadline)
  if (deadline === undefined) {
    return {
      ok: false,
      error: 'That deadline could not be understood. Pick a date and time again.',
      fieldErrors: { deadline: 'Invalid date.' },
    }
  }

  /*
   * No template means students get empty repositories. Nothing to parse and nothing
   * to check against GitHub, so both are skipped rather than made to tolerate an
   * empty string — a blank field is a decision, not a missing value.
   */
  const template = input.template
    ? parseTemplateReference(input.template, classroom.githubOrgLogin)
    : null

  if (input.template && !template) {
    return {
      ok: false,
      error: 'Enter the template as owner/repo, or paste its GitHub URL.',
      fieldErrors: { template: 'Could not read that as a repository.' },
    }
  }

  // Validated now rather than at provisioning time: otherwise a typo surfaces as
  // hundreds of identically failed jobs instead of one form error.
  if (template) {
    try {
      const check = await validateTemplate(classroom.installationId, template.owner, template.repo)
      if (!check.ok) {
        return { ok: false, error: check.reason, fieldErrors: { template: check.reason } }
      }
    } catch (error) {
      const message =
        error instanceof GitHubDomainError ? error.userMessage : 'Could not reach GitHub.'
      return { ok: false, error: message, fieldErrors: { template: message } }
    }
  }

  const existingSlugs = new Set(
    (
      await db.assignment.findMany({
        where: { classroomId },
        select: { slug: true },
      })
    ).map((a) => a.slug),
  )
  const slug = dedupeSlug(buildClassroomSlug({ name: input.title }), existingSlugs)

  const assignment = await db.assignment.create({
    data: {
      classroomId,
      title: input.title,
      slug,
      type: input.type,
      templateOwner: template?.owner ?? null,
      templateRepo: template?.repo ?? null,
      repoPrefix: input.repoPrefix,
      visibility: input.visibility,
      studentPermission: input.studentPermission,
      deadline,
      lockOnDeadline: input.lockOnDeadline,
      feedbackPrEnabled: input.feedbackPrEnabled,
      autogradeEnabled: input.autogradeEnabled,
      maxTeams: input.type === 'GROUP' ? (input.maxTeams ?? null) : null,
      maxTeamSize: input.type === 'GROUP' ? (input.maxTeamSize ?? null) : null,
      publishedAt: input.publish ? new Date() : null,
    },
    select: { id: true, title: true },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'assignment.create',
      targetType: 'assignment',
      targetId: assignment.id,
      detail: {
        title: assignment.title,
        template: template ? `${template.owner}/${template.repo}` : null,
        type: input.type,
        published: input.publish,
      },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}`)
  redirect(`/classrooms/${classroom.slug}/assignments/${assignment.id}`)
}

export async function setAssignmentPublished(
  formData: FormData,
): Promise<AssignmentActionResult> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const publish = formData.get('publish') === 'true'

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, classroomId: true, title: true, classroom: { select: { slug: true } } },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  await db.assignment.update({
    where: { id: assignmentId },
    data: { publishedAt: publish ? new Date() : null },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: publish ? 'assignment.publish' : 'assignment.unpublish',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { title: assignment.title },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}`)
  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: undefined }
}

/**
 * A student accepts an assignment.
 *
 * Creating the row and enqueuing the job are separate steps, and the unique
 * constraint on (assignmentId, userId) is what makes a double-click safe: the
 * second attempt finds the existing row and re-enqueues against the same
 * singleton key rather than creating a second repository.
 */
export async function acceptAssignment(
  formData: FormData,
): Promise<AssignmentActionResult<{ status: string }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const user = await requireUser()

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      type: true,
      publishedAt: true,
      classroomId: true,
      classroom: { select: { slug: true, archivedAt: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  // Membership check, and it must be a classroom the student actually belongs to.
  await requireClassroomRole(assignment.classroomId)

  if (!assignment.publishedAt) {
    return { ok: false, error: 'This assignment has not been published yet.' }
  }
  if (assignment.classroom.archivedAt) {
    return { ok: false, error: 'This classroom is archived.' }
  }
  if (assignment.type !== 'INDIVIDUAL') {
    return { ok: false, error: 'This is a group assignment — join or create a team instead.' }
  }

  // A student must have claimed a roster entry: otherwise there is no way to
  // attribute their work, and repository naming has no stable identifier.
  const rosterEntry = await db.rosterEntry.findFirst({
    where: { classroomId: assignment.classroomId, claimedByUserId: user.id, removedAt: null },
    select: { id: true },
  })
  if (!rosterEntry) {
    return {
      ok: false,
      error:
        'Link your GitHub account to your name on the class roster first, using the invite ' +
        'link from your instructor.',
    }
  }

  const existing = await db.assignmentRepo.findUnique({
    where: { assignmentId_userId: { assignmentId, userId: user.id } },
    select: { id: true, status: true },
  })

  const repoRow =
    existing ??
    (await db.assignmentRepo.create({
      data: { assignmentId, userId: user.id, status: RepoStatus.QUEUED },
      select: { id: true, status: true },
    }))

  // Re-enqueue when not already finished; the singleton key collapses duplicates.
  if (repoRow.status !== RepoStatus.READY) {
    await enqueue(
      QUEUES.provisionIndividualRepo,
      { assignmentRepoId: repoRow.id },
      { singletonKey: repoRow.id },
    )
  }

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { status: repoRow.status } }
}

/**
 * Pre-provision repositories for every registered student who has none.
 *
 * Returns the ETA so the UI can say how long this will take. A large class
 * legitimately takes tens of minutes — that is the rate limit, not a bug.
 */
export async function bulkProvision(
  formData: FormData,
): Promise<AssignmentActionResult<{ queued: number; skipped: number; eta: string }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      type: true,
      classroomId: true,
      feedbackPrEnabled: true,
      autogradeEnabled: true,
      classroom: { select: { slug: true, archivedAt: true } },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  if (assignment.type !== 'INDIVIDUAL') {
    return {
      ok: false,
      error: 'Bulk provisioning applies to individual assignments. Group repos follow team formation.',
    }
  }
  if (assignment.classroom.archivedAt) {
    return { ok: false, error: 'This classroom is archived.' }
  }

  // Only students who have linked a GitHub account can have a repo created.
  const claimed = await db.rosterEntry.findMany({
    where: {
      classroomId: assignment.classroomId,
      removedAt: null,
      claimedByUserId: { not: null },
    },
    select: { claimedByUserId: true },
  })

  const candidateUserIds = claimed
    .map((c) => c.claimedByUserId)
    .filter((id): id is string => id !== null)

  const alreadyHave = await db.assignmentRepo.findMany({
    where: { assignmentId, userId: { in: candidateUserIds } },
    select: { userId: true },
  })
  const have = new Set(alreadyHave.map((r) => r.userId))

  const toCreate = candidateUserIds.filter((id) => !have.has(id))

  if (toCreate.length === 0) {
    return {
      ok: true,
      data: { queued: 0, skipped: have.size, eta: 'nothing to do' },
    }
  }

  const created = await db.$transaction(
    toCreate.map((userId) =>
      db.assignmentRepo.create({
        data: { assignmentId, userId, status: RepoStatus.QUEUED },
        select: { id: true },
      }),
    ),
  )

  await enqueueMany(
    QUEUES.provisionIndividualRepo,
    created.map((row) => ({ data: { assignmentRepoId: row.id }, singletonKey: row.id })),
  )

  const perRepo = callsPerRepo({
    feedbackPr: assignment.feedbackPrEnabled,
    autograde: assignment.autogradeEnabled,
  })
  const eta = formatDuration(estimateProvisioningMs(created.length * perRepo))

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.bulk_provision',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { queued: created.length, alreadyHad: have.size, estimatedCalls: created.length * perRepo },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { queued: created.length, skipped: have.size, eta } }
}

/** Re-queue every failed repository for this assignment. */
export async function retryFailedRepos(
  formData: FormData,
): Promise<AssignmentActionResult<{ retried: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, classroomId: true, classroom: { select: { slug: true } } },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  const failed = await db.assignmentRepo.findMany({
    where: { assignmentId, status: RepoStatus.FAILED },
    select: { id: true },
  })

  if (failed.length === 0) return { ok: true, data: { retried: 0 } }

  await db.assignmentRepo.updateMany({
    where: { id: { in: failed.map((f) => f.id) } },
    data: { status: RepoStatus.QUEUED, failureReason: null },
  })

  await enqueueMany(
    QUEUES.provisionIndividualRepo,
    failed.map((f) => ({ data: { assignmentRepoId: f.id }, singletonKey: f.id })),
  )

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.retry_failed',
      targetType: 'assignment',
      targetId: assignmentId,
      detail: { retried: failed.length },
    },
  })

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { retried: failed.length } }
}
