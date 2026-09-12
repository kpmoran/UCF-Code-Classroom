'use server'

import { RepoStatus } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireClassroomRole, requireInstructor, requireUser } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { getRepo, listTemplateRepos, validateTemplate } from '@/lib/github/operations/repos'
import { canAdoptRepo } from '@/lib/repos/adopt'
import { estimateProvisioningMs, formatDuration } from '@/lib/github/rateLimiter'
import { enqueue, enqueueMany, QUEUES } from '@/jobs/queue'
import { buildClassroomSlug, dedupeSlug } from '@/lib/slug'

import { callsPerRepo } from './estimate'
import {
  createAssignmentSchema,
  parseDeadline,
  parseRepoReference,
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
    projectBoardEnabled: formData.get('projectBoardEnabled') === 'on',
    maxTeams: formData.get('maxTeams') || undefined,
    maxTeamSize: formData.get('maxTeamSize') || undefined,
    repoSource: formData.get('repoSource') || undefined,
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
   * A template describes a repository this app is about to create. An assignment
   * that adopts repositories which already exist creates none, so the field is
   * dropped rather than stored — a template recorded there would be a setting that
   * silently does nothing, which is worse than no setting at all.
   */
  const adoptsExistingRepos = input.repoSource === 'EXISTING'

  /*
   * No template means students get empty repositories. Nothing to parse and nothing
   * to check against GitHub, so both are skipped rather than made to tolerate an
   * empty string — a blank field is a decision, not a missing value.
   */
  const template =
    input.template && !adoptsExistingRepos
      ? parseRepoReference(input.template, classroom.githubOrgLogin)
      : null

  if (input.template && !adoptsExistingRepos && !template) {
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
      projectBoardEnabled: input.projectBoardEnabled,
      maxTeams: input.type === 'GROUP' ? (input.maxTeams ?? null) : null,
      maxTeamSize: input.type === 'GROUP' ? (input.maxTeamSize ?? null) : null,
      repoSource: input.repoSource,
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
      repoSource: true,
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

  /*
   * Nothing for a student to accept when the repositories already exist: which one
   * they work in is the instructor's decision, and there is none to create. Letting
   * the row be made here would only queue a job that fails for want of a repository,
   * and repeat that on every click.
   */
  if (assignment.repoSource === 'EXISTING') {
    return {
      ok: false,
      error:
        'Your instructor assigns the repository for this assignment. It will appear here once ' +
        'they have.',
    }
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
      repoSource: true,
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

  /*
   * There is nothing to provision in bulk when the repositories already exist: which
   * student works in which one cannot be guessed, so the rows are created by
   * assigning them one at a time.
   */
  if (assignment.repoSource === 'EXISTING') {
    return {
      ok: false,
      error:
        'This assignment uses repositories that already exist. Assign each student theirs ' +
        'from the Repositories tab instead.',
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

/**
 * Instructor: assign a student a repository that already exists.
 *
 * The individual counterpart to `linkTeamRepo`, and the only way a row is created on
 * an assignment whose `repoSource` is EXISTING — students cannot accept their way
 * into one, because which repository they belong in is not something they can know.
 *
 * Several students may be assigned the *same* repository, deliberately: a shared
 * course project, or a codebase a group works in together while being graded
 * individually. Each keeps their own row, so access, extensions, the deadline lock
 * and grades stay per-student; the rows just share a `fullName`. Nothing is refused
 * for a repository being taken, which is the one place this differs from the team
 * path.
 */
export async function assignStudentRepo(
  formData: FormData,
): Promise<AssignmentActionResult<{ shared: number }>> {
  const assignmentId = String(formData.get('assignmentId') ?? '')
  const studentUserId = String(formData.get('studentUserId') ?? '')
  const raw = String(formData.get('repo') ?? '').trim()

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      type: true,
      repoSource: true,
      classroomId: true,
      classroom: {
        select: {
          slug: true,
          archivedAt: true,
          githubOrgLogin: true,
          installationId: true,
        },
      },
    },
  })
  if (!assignment) return { ok: false, error: 'That assignment no longer exists.' }

  const { user } = await requireInstructor(assignment.classroomId)

  if (assignment.classroom.archivedAt) {
    return { ok: false, error: 'This classroom is archived. Restore it to change assignments.' }
  }
  if (assignment.type !== 'INDIVIDUAL') {
    return { ok: false, error: 'This is a group assignment — link the team’s repository instead.' }
  }
  if (!raw) return { ok: false, error: 'Enter a repository as owner/name, or paste its URL.' }

  const org = assignment.classroom.githubOrgLogin
  const ref = parseRepoReference(raw, org)

  // Sharing is allowed here, so no conflict is ever supplied — see the note above.
  const rule = canAdoptRepo({
    repoSource: assignment.repoSource,
    orgLogin: org,
    ref,
    conflictsWith: null,
  })
  if (!rule.allowed) return { ok: false, error: rule.reason }
  // Narrowing only: the rule already refused a null reference.
  if (!ref) return { ok: false, error: 'Could not read that as a repository.' }

  const student = await db.user.findUnique({
    where: { id: studentUserId },
    select: { id: true, githubLogin: true, name: true },
  })
  if (!student) return { ok: false, error: 'That student no longer exists.' }

  /*
   * A student with no linked GitHub account cannot be given access to anything, and
   * the provisioning job would only fail on the same fact. Said here instead, where
   * it is one message next to the row rather than a failed job to go and read.
   */
  if (!student.githubLogin) {
    return {
      ok: false,
      error:
        `${student.name ?? 'That student'} has not linked a GitHub account yet, so they cannot ` +
        'be given access. Ask them to sign in and claim their roster entry first.',
    }
  }

  const member = await db.classroomMember.findFirst({
    where: { classroomId: assignment.classroomId, userId: studentUserId },
    select: { id: true },
  })
  if (!member) return { ok: false, error: 'That student is not in this classroom.' }

  let found
  try {
    found = await getRepo(assignment.classroom.installationId, ref.owner, ref.repo)
  } catch (error) {
    const message =
      error instanceof GitHubDomainError ? error.userMessage : 'Could not reach GitHub.'
    return { ok: false, error: message }
  }

  if (!found) {
    return {
      ok: false,
      error:
        `There is no repository called ${ref.owner}/${ref.repo}, or this app cannot see it. ` +
        'Check the name, and that the GitHub App has access to it.',
    }
  }

  /*
   * Reassigning is allowed and leaves the previous repository alone — the student
   * keeps whatever access they were granted there. Revoking it is a separate,
   * deliberate act (Remove from assignment), for the same reason moving a student
   * between teams does not strip their old team's access: cutting someone off from
   * work they have already committed should never be a side effect of fixing a typo.
   */
  const row = await db.assignmentRepo.upsert({
    where: { assignmentId_userId: { assignmentId, userId: studentUserId } },
    create: {
      assignmentId,
      userId: studentUserId,
      status: RepoStatus.QUEUED,
      githubRepoId: found.id,
      fullName: found.fullName,
      htmlUrl: found.htmlUrl,
    },
    update: {
      status: RepoStatus.QUEUED,
      failureReason: null,
      githubRepoId: found.id,
      fullName: found.fullName,
      htmlUrl: found.htmlUrl,
    },
    select: { id: true },
  })

  // Reported back so the instructor sees that a repository is shared, rather than
  // discovering it when two students turn out to have identical grades.
  const shared = await db.assignmentRepo.count({
    where: { assignmentId, githubRepoId: found.id, NOT: { id: row.id } },
  })

  await db.auditLog.create({
    data: {
      classroomId: assignment.classroomId,
      actorUserId: user.id,
      action: 'assignment.assign_repo',
      targetType: 'assignmentRepo',
      targetId: row.id,
      detail: { studentUserId, repo: found.fullName, sharedWith: shared },
    },
  })

  await enqueue(
    QUEUES.provisionIndividualRepo,
    { assignmentRepoId: row.id },
    { singletonKey: row.id },
  )

  revalidatePath(`/classrooms/${assignment.classroom.slug}/assignments/${assignmentId}`)
  return { ok: true, data: { shared } }
}
