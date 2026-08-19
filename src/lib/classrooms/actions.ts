'use server'

import { ClassroomRole } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireFaculty, requireInstructor } from '@/lib/auth/dal'
import { generateInviteToken } from '@/lib/crypto'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { checkOrgOwnership, listAppInstallations } from '@/lib/github/operations/orgs'
import { buildClassroomSlug, dedupeSlug } from '@/lib/slug'

import {
  archiveClassroomSchema,
  createClassroomSchema,
  updateClassroomSchema,
  type ActionResult,
} from './schemas'

/**
 * Classroom mutations.
 *
 * Every action re-authorizes through the data access layer. Server actions are
 * ordinary HTTP endpoints — the fact that only an instructor's page renders the
 * form is not a permission check.
 */

async function takenSlugs(): Promise<Set<string>> {
  const rows = await db.classroom.findMany({ select: { slug: true } })
  return new Set(rows.map((r) => r.slug))
}

export async function createClassroom(formData: FormData): Promise<ActionResult<never>> {
  // The real boundary. The page check above it is only UX — a form can be posted
  // directly, so a page-only guard is no guard at all.
  const user = await requireFaculty()

  const parsed = createClassroomSchema.safeParse({
    name: formData.get('name'),
    courseCode: formData.get('courseCode') ?? undefined,
    term: formData.get('term') ?? undefined,
    installationId: formData.get('installationId'),
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.')
      fieldErrors[key] ??= issue.message
    }
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const { name, courseCode, term, installationId } = parsed.data

  // The installation must be one this App actually has, not merely an id the
  // client posted.
  const installations = await listAppInstallations()
  const installation = installations.find((i) => i.installationId.toString() === installationId)
  if (!installation) {
    return {
      ok: false,
      error:
        'That GitHub organization is no longer available to this app. Reinstall the app on ' +
        'the organization and try again.',
    }
  }

  if (installation.repositorySelection !== 'all') {
    return {
      ok: false,
      error:
        `The app is installed on ${installation.orgLogin} with access to only selected ` +
        'repositories. It must have access to all repositories, because it creates new ones. ' +
        'Change this in the organization’s installation settings.',
    }
  }

  if (await db.classroom.findFirst({ where: { githubOrgId: installation.orgId } })) {
    // Two classrooms in one org would generate colliding repository names for
    // assignments that share a prefix.
    return {
      ok: false,
      error:
        `A classroom already uses the ${installation.orgLogin} organization. Use a different ` +
        'organization for this course, or archive the existing classroom.',
    }
  }

  // Warn-not-block on ownership: everything except group assignments works for a
  // non-owner, and blocking here would strand an instructor whose promotion to
  // Owner is still pending.
  let ownershipWarning: string | null = null
  try {
    if (user.githubLogin) {
      const ownership = await checkOrgOwnership(
        installation.installationId,
        installation.orgLogin,
        user.githubLogin,
      )
      if (!ownership.isOwner) ownershipWarning = ownership.reason
    }
  } catch (error) {
    ownershipWarning =
      error instanceof GitHubDomainError
        ? error.userMessage
        : 'Could not confirm your organization role.'
  }

  const slug = dedupeSlug(buildClassroomSlug({ name, courseCode, term }), await takenSlugs())

  const classroom = await db.classroom.create({
    data: {
      name,
      courseCode,
      term,
      slug,
      githubOrgLogin: installation.orgLogin,
      githubOrgId: installation.orgId,
      installationId: installation.installationId,
      // Recorded as the fallback credential holder for team operations.
      ownerTokenUserId: user.id,
      members: { create: { userId: user.id, role: ClassroomRole.INSTRUCTOR } },
      inviteLinks: { create: { token: generateInviteToken() } },
    },
    select: { id: true, slug: true },
  })

  await db.auditLog.create({
    data: {
      classroomId: classroom.id,
      actorUserId: user.id,
      action: 'classroom.create',
      targetType: 'classroom',
      targetId: classroom.id,
      detail: {
        org: installation.orgLogin,
        installationId: installation.installationId.toString(),
        ownershipWarning,
      },
    },
  })

  revalidatePath('/')
  // Carry the warning in the URL so the classroom page can surface it once,
  // rather than silently dropping a real problem.
  redirect(
    ownershipWarning
      ? `/classrooms/${classroom.slug}?notOwner=1`
      : `/classrooms/${classroom.slug}`,
  )
}

export async function updateClassroom(formData: FormData): Promise<ActionResult<never>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user } = await requireInstructor(classroomId)

  const parsed = updateClassroomSchema.safeParse({
    classroomId,
    name: formData.get('name'),
    courseCode: formData.get('courseCode') ?? undefined,
    term: formData.get('term') ?? undefined,
    defaultRepoVisibility: formData.get('defaultRepoVisibility'),
    defaultStudentPermission: formData.get('defaultStudentPermission'),
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid settings.' }
  }

  const { name, courseCode, term, defaultRepoVisibility, defaultStudentPermission } = parsed.data

  // The slug is deliberately left alone: it is in students' bookmarks and in
  // every invite link already handed out.
  const updated = await db.classroom.update({
    where: { id: classroomId },
    data: { name, courseCode, term, defaultRepoVisibility, defaultStudentPermission },
    select: { slug: true },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'classroom.update',
      targetType: 'classroom',
      targetId: classroomId,
      detail: { name, courseCode, term, defaultRepoVisibility, defaultStudentPermission },
    },
  })

  revalidatePath(`/classrooms/${updated.slug}`)
  revalidatePath(`/classrooms/${updated.slug}/settings`)
  return { ok: true, data: undefined as never }
}

export async function setClassroomArchived(formData: FormData): Promise<ActionResult<never>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  const parsed = archiveClassroomSchema.safeParse({
    classroomId,
    confirmSlug: formData.get('confirmSlug'),
    archive: formData.get('archive'),
  })

  if (!parsed.success) {
    return { ok: false, error: 'Invalid request.' }
  }

  const archive = parsed.data.archive === 'true'

  if (archive && parsed.data.confirmSlug.trim() !== classroom.slug) {
    return {
      ok: false,
      error: `Type “${classroom.slug}” exactly to confirm archiving this classroom.`,
    }
  }

  await db.classroom.update({
    where: { id: classroomId },
    data: { archivedAt: archive ? new Date() : null },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: archive ? 'classroom.archive' : 'classroom.unarchive',
      targetType: 'classroom',
      targetId: classroomId,
    },
  })

  revalidatePath('/')
  revalidatePath(`/classrooms/${classroom.slug}`)
  revalidatePath(`/classrooms/${classroom.slug}/settings`)
  return { ok: true, data: undefined as never }
}

/** Rotate the classroom's invite link, invalidating the previous one. */
export async function regenerateInviteLink(formData: FormData): Promise<ActionResult<never>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  await db.$transaction([
    // Revoke rather than delete: an audit trail of who could join when is worth
    // keeping, and students who already joined are unaffected either way.
    db.inviteLink.updateMany({
      where: { classroomId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    db.inviteLink.create({ data: { classroomId, token: generateInviteToken() } }),
  ])

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'classroom.invite_link.regenerate',
      targetType: 'classroom',
      targetId: classroomId,
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/settings`)
  return { ok: true, data: undefined as never }
}
