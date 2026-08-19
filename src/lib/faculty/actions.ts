'use server'

import { revalidatePath } from 'next/cache'

import { requireSiteAdmin, requireUser } from '@/lib/auth/dal'
import { generateInviteToken } from '@/lib/crypto'
import { db } from '@/lib/db'

/**
 * Faculty invitations.
 *
 * Signing in with GitHub proves only that someone has a GitHub account, and every
 * student has one — so it cannot be what decides who may create a classroom. This is
 * the gate: a site admin issues a link, a colleague redeems it, and only then can
 * they create classrooms.
 *
 * The link is a privilege escalation if it leaks, so it is bounded the same way the
 * student invite links are: single-use by default, optionally expiring, revocable,
 * and every redemption recorded against the person who used it.
 */

export type FacultyActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const MAX_NOTE = 200

export async function createFacultyInvite(
  formData: FormData,
): Promise<FacultyActionResult<{ token: string }>> {
  const admin = await requireSiteAdmin()

  const rawNote = String(formData.get('note') ?? '').trim()
  if (rawNote.length > MAX_NOTE) {
    return { ok: false, error: `Keep the note under ${MAX_NOTE} characters.` }
  }

  const maxUses = Number(String(formData.get('maxUses') ?? '1'))
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) {
    return { ok: false, error: 'Uses must be a whole number between 1 and 50.' }
  }

  const days = Number(String(formData.get('expiresInDays') ?? '14'))
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { ok: false, error: 'Expiry must be between 1 and 365 days.' }
  }

  const invite = await db.facultyInvite.create({
    data: {
      token: generateInviteToken(),
      note: rawNote === '' ? null : rawNote,
      maxUses,
      // Always set. An invite that grants classroom-creation rights forever is a
      // credential nobody remembers issuing; a default expiry means a forgotten link
      // stops being a liability on its own.
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      createdByUserId: admin.id,
    },
    select: { token: true },
  })

  await db.auditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'faculty.invite_created',
      targetType: 'facultyInvite',
      targetId: invite.token.slice(0, 8),
      detail: { note: rawNote || null, maxUses, expiresInDays: days },
    },
  })

  revalidatePath('/admin/faculty')
  return { ok: true, data: { token: invite.token } }
}

export async function revokeFacultyInvite(
  formData: FormData,
): Promise<FacultyActionResult> {
  const admin = await requireSiteAdmin()
  const id = String(formData.get('inviteId') ?? '')

  const invite = await db.facultyInvite.findUnique({
    where: { id },
    select: { id: true, revokedAt: true, note: true },
  })
  if (!invite) return { ok: false, error: 'That invitation no longer exists.' }
  if (invite.revokedAt) return { ok: true, data: undefined }

  await db.facultyInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() },
  })

  await db.auditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'faculty.invite_revoked',
      targetType: 'facultyInvite',
      targetId: invite.id,
      detail: { note: invite.note },
    },
  })

  revalidatePath('/admin/faculty')
  return { ok: true, data: undefined }
}

/**
 * Withdraw someone's faculty rights.
 *
 * Deliberately does not touch the classrooms they already run: they stay an
 * INSTRUCTOR of those through ClassroomMember, because removing someone mid-semester
 * from courses full of student work is a different and much larger decision than
 * "should they be able to start new ones".
 */
export async function setFacultyStatus(
  formData: FormData,
): Promise<FacultyActionResult> {
  const admin = await requireSiteAdmin()
  const userId = String(formData.get('userId') ?? '')
  const grant = formData.get('grant') === 'true'

  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, githubLogin: true, isFaculty: true },
  })
  if (!target) return { ok: false, error: 'That account no longer exists.' }

  if (target.id === admin.id && !grant) {
    return { ok: false, error: 'You cannot remove your own faculty access.' }
  }

  await db.user.update({ where: { id: target.id }, data: { isFaculty: grant } })

  await db.auditLog.create({
    data: {
      actorUserId: admin.id,
      action: grant ? 'faculty.granted' : 'faculty.revoked',
      targetType: 'user',
      targetId: target.id,
      detail: { githubLogin: target.githubLogin },
    },
  })

  revalidatePath('/admin/faculty')
  return { ok: true, data: undefined }
}

export type RedeemOutcome =
  | { ok: true; alreadyFaculty: boolean }
  | { ok: false; reason: 'invalid' | 'revoked' | 'expired' | 'exhausted' }

/**
 * Is this invitation usable, without consuming it?
 *
 * Separate from redeeming because the landing page is a GET, and redeeming on a GET
 * is wrong twice over: mutating during a render is not allowed in Next.js, and — more
 * importantly — link scanners follow URLs. Mail clients, Slack unfurls and security
 * proxies would each silently burn a single-use invitation before the recipient ever
 * clicked it.
 *
 * Returns a boolean rather than a reason, for the same purpose as the single error
 * message the page renders: distinguishing "no such token" from "already used" would
 * confirm a token exists to anyone guessing.
 */
export async function facultyInviteIsUsable(token: string): Promise<boolean> {
  const user = await requireUser()

  const invite = await db.facultyInvite.findUnique({
    where: { token },
    select: {
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      _count: { select: { redemptions: true } },
      redemptions: { where: { userId: user.id }, select: { id: true }, take: 1 },
    },
  })
  if (!invite) return false
  // Already theirs: still "usable", so they get a confirming page rather than a scare.
  if (invite.redemptions.length > 0) return true
  if (invite.revokedAt) return false
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return false
  return invite._count.redemptions < invite.maxUses
}

/**
 * Redeem an invitation for the signed-in user.
 *
 * Every rejection returns the same shape and the page renders one message for all of
 * them, so probing tokens cannot distinguish "no such invite" from "that one is used
 * up" — the difference would confirm a token exists.
 *
 * The redemption row and the flag are written in one transaction, and the row has a
 * unique constraint on (invite, user). That makes a double click idempotent rather
 * than consuming two of a two-use invite, and stops two concurrent requests from
 * both passing the remaining-uses check.
 */
export async function redeemFacultyInvite(formData: FormData): Promise<RedeemOutcome> {
  const user = await requireUser()
  const token = String(formData.get('token') ?? '')

  const invite = await db.facultyInvite.findUnique({
    where: { token },
    select: {
      id: true,
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      _count: { select: { redemptions: true } },
      redemptions: { where: { userId: user.id }, select: { id: true }, take: 1 },
    },
  })

  if (!invite) return { ok: false, reason: 'invalid' }

  // Already redeemed by this person: succeed without spending another use.
  if (invite.redemptions.length > 0) {
    if (!user.isFaculty) {
      await db.user.update({ where: { id: user.id }, data: { isFaculty: true } })
      return { ok: true, alreadyFaculty: false }
    }
    return { ok: true, alreadyFaculty: true }
  }

  if (invite.revokedAt) return { ok: false, reason: 'revoked' }
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  if (invite._count.redemptions >= invite.maxUses) {
    return { ok: false, reason: 'exhausted' }
  }

  try {
    await db.$transaction([
      db.facultyInviteRedemption.create({
        data: { inviteId: invite.id, userId: user.id },
      }),
      db.user.update({ where: { id: user.id }, data: { isFaculty: true } }),
      db.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'faculty.invite_redeemed',
          targetType: 'facultyInvite',
          targetId: invite.id,
          detail: { githubLogin: user.githubLogin },
        },
      }),
    ])
  } catch (error) {
    // A racing duplicate hit the unique constraint, which means the other request
    // granted access. Report success rather than a confusing error.
    if ((error as { code?: string }).code === 'P2002') {
      return { ok: true, alreadyFaculty: false }
    }
    throw error
  }

  revalidatePath('/')
  return { ok: true, alreadyFaculty: false }
}
