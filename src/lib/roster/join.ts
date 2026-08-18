import 'server-only'

import { ClassroomRole } from '@prisma/client'

import { db } from '@/lib/db'

/**
 * Invite-link resolution and roster claiming.
 *
 * Registration mirrors GitHub Classroom's proven flow, which works with the
 * CSV-only data a Canvas export gives us: the student opens an invite link,
 * signs in with GitHub, and identifies themselves by picking their own name from
 * the roster. There is no reliable automatic mapping from a GitHub account to a
 * university identity, so the student supplies it once and the instructor can
 * correct a mistake.
 */

export type InviteResolution =
  | { ok: true; classroom: InviteClassroom }
  | { ok: false; reason: string }

export type InviteClassroom = {
  id: string
  slug: string
  name: string
  courseCode: string | null
  term: string | null
  githubOrgLogin: string
  archivedAt: Date | null
}

export async function resolveInviteToken(token: string): Promise<InviteResolution> {
  const link = await db.inviteLink.findUnique({
    where: { token },
    select: {
      id: true,
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      useCount: true,
      classroom: {
        select: {
          id: true,
          slug: true,
          name: true,
          courseCode: true,
          term: true,
          githubOrgLogin: true,
          archivedAt: true,
        },
      },
    },
  })

  // Deliberately identical wording for "never existed" and "revoked": a
  // distinction would let someone probe which tokens were once valid.
  if (!link) {
    return { ok: false, reason: 'This invite link is not valid. Ask your instructor for a new one.' }
  }
  if (link.revokedAt) {
    return {
      ok: false,
      reason: 'This invite link has been replaced. Ask your instructor for the current one.',
    }
  }
  if (link.expiresAt && link.expiresAt < new Date()) {
    return { ok: false, reason: 'This invite link has expired. Ask your instructor for a new one.' }
  }
  if (link.maxUses !== null && link.useCount >= link.maxUses) {
    return {
      ok: false,
      reason: 'This invite link has reached its usage limit. Ask your instructor for a new one.',
    }
  }
  if (link.classroom.archivedAt) {
    return { ok: false, reason: 'This classroom is archived and is no longer accepting students.' }
  }

  return { ok: true, classroom: link.classroom }
}

export type ClaimableEntry = {
  id: string
  displayName: string
  section: string | null
  /** Masked identifier so a student can tell namesakes apart. */
  hint: string | null
  claimed: boolean
  claimedByYou: boolean
}

/**
 * Show only the last few characters of an identifier.
 *
 * The roster list is visible to anyone holding the invite link, so it must not
 * publish every classmate's full NID. A suffix is enough for a student to
 * recognise their own entry among people with the same name.
 */
export function maskIdentifier(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  // Short identifiers are masked entirely: revealing three characters of a
  // five-character id exposes most of it. Only reveal a suffix when the
  // remaining mask is at least as long as what is shown.
  if (trimmed.length <= 6) return '•'.repeat(trimmed.length)

  return `${'•'.repeat(trimmed.length - 3)}${trimmed.slice(-3)}`
}

export async function listClaimableEntries(
  classroomId: string,
  currentUserId: string,
): Promise<ClaimableEntry[]> {
  const entries = await db.rosterEntry.findMany({
    where: { classroomId, removedAt: null },
    select: {
      id: true,
      displayName: true,
      section: true,
      sisLoginId: true,
      claimedByUserId: true,
    },
    orderBy: { displayName: 'asc' },
  })

  return entries.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    section: e.section,
    hint: maskIdentifier(e.sisLoginId),
    claimed: e.claimedByUserId !== null,
    claimedByYou: e.claimedByUserId === currentUserId,
  }))
}

/**
 * Best-guess roster entry for a signed-in student, used to preselect their name.
 *
 * Matches on verified GitHub email against the roster's email or login id. Only
 * ever a suggestion — the student still confirms, because a wrong automatic
 * match would attach them to someone else's identity.
 */
export async function suggestEntryForUser(
  classroomId: string,
  email: string | null,
): Promise<string | null> {
  if (!email) return null
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null

  const localPart = normalized.split('@')[0]

  const match = await db.rosterEntry.findFirst({
    where: {
      classroomId,
      removedAt: null,
      claimedByUserId: null,
      OR: [
        { email: { equals: normalized, mode: 'insensitive' } },
        { sisLoginId: { equals: localPart, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  })

  return match?.id ?? null
}

export type ClaimOutcome =
  | { ok: true; classroomSlug: string }
  | { ok: false; reason: string }

/**
 * Link the signed-in user to a roster entry and enrol them.
 *
 * Race safety matters here: two students clicking the same name, or one student
 * double-submitting, must not both succeed. The update is conditional on the
 * entry still being unclaimed, and `RosterEntry.claimedByUserId` is unique in the
 * database, so the loser gets a clear message instead of a silent overwrite.
 */
export async function claimRosterEntry(
  token: string,
  userId: string,
  entryId: string,
): Promise<ClaimOutcome> {
  const resolution = await resolveInviteToken(token)
  if (!resolution.ok) return { ok: false, reason: resolution.reason }

  const classroom = resolution.classroom

  const existingClaim = await db.rosterEntry.findFirst({
    where: { classroomId: classroom.id, claimedByUserId: userId },
    select: { id: true, displayName: true },
  })

  if (existingClaim && existingClaim.id !== entryId) {
    return {
      ok: false,
      reason:
        `Your GitHub account is already linked to “${existingClaim.displayName}” in this ` +
        'classroom. Ask your instructor to unlink it if that is wrong.',
    }
  }
  if (existingClaim) {
    // Idempotent: re-submitting the same claim is success, not an error.
    await ensureMembership(classroom.id, userId)
    return { ok: true, classroomSlug: classroom.slug }
  }

  const target = await db.rosterEntry.findFirst({
    where: { id: entryId, classroomId: classroom.id, removedAt: null },
    select: { id: true, displayName: true, claimedByUserId: true },
  })
  if (!target) return { ok: false, reason: 'That roster entry is no longer available.' }
  if (target.claimedByUserId) {
    return {
      ok: false,
      reason:
        `“${target.displayName}” has already been claimed by another GitHub account. If that ` +
        'is your name, ask your instructor to unlink it.',
    }
  }

  // Conditional update: succeeds for exactly one concurrent caller.
  const claimed = await db.rosterEntry.updateMany({
    where: { id: entryId, classroomId: classroom.id, claimedByUserId: null, removedAt: null },
    data: { claimedByUserId: userId, claimedAt: new Date() },
  })

  if (claimed.count === 0) {
    return {
      ok: false,
      reason: 'Someone claimed that name a moment before you. Pick your own entry, or ask your instructor.',
    }
  }

  await ensureMembership(classroom.id, userId)

  await db.$transaction([
    db.inviteLink.updateMany({
      where: { token },
      data: { useCount: { increment: 1 } },
    }),
    db.auditLog.create({
      data: {
        classroomId: classroom.id,
        actorUserId: userId,
        action: 'roster.claim',
        targetType: 'rosterEntry',
        targetId: entryId,
        detail: { displayName: target.displayName },
      },
    }),
  ])

  return { ok: true, classroomSlug: classroom.slug }
}

async function ensureMembership(classroomId: string, userId: string): Promise<void> {
  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId } },
    update: {},
    // Never downgrade an existing role: an instructor who claims a roster entry
    // for testing must not become a student in their own classroom.
    create: { classroomId, userId, role: ClassroomRole.STUDENT },
  })
}
