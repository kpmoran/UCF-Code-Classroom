'use server'

import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'

import { requireInstructor } from '@/lib/auth/dal'
import {
  diffRoster,
  type ExistingRosterEntry,
  type RosterDiff,
} from '@/lib/canvas/diffRoster'
import { parseRosterCsv, RosterParseError } from '@/lib/canvas/parseRoster'
import { db } from '@/lib/db'

/**
 * Roster import and maintenance.
 *
 * Import is a two-step preview-then-apply. The apply step **re-parses and
 * re-diffs the CSV server-side** rather than trusting a plan posted by the
 * client: the plan decides whether students lose access, so it must be derived
 * from data the server validated, not from form fields an attacker controls.
 */

export type RosterPreview = {
  ok: true
  csv: string
  fileName: string
  parse: {
    matchedColumns: Record<string, string | null>
    passthroughColumns: string[]
    warnings: string[]
    skipped: Array<{ reason: string; line: number; value: string }>
    totalRows: number
  }
  diff: {
    added: Array<{ displayName: string; sisUserId: string | null; section: string | null }>
    updated: Array<{
      id: string
      displayName: string
      changes: Array<{ field: string; from: string | null; to: string | null }>
    }>
    unchangedCount: number
    restored: Array<{ id: string; displayName: string }>
    removed: Array<{ id: string; displayName: string; claimed: boolean }>
    destructive: Array<{ id: string; displayName: string; consequence: string }>
    matchedBy: { sisUserId: number; sisLoginId: number; displayName: number }
  }
}

export type RosterActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

async function loadExisting(classroomId: string): Promise<ExistingRosterEntry[]> {
  const entries = await db.rosterEntry.findMany({
    where: { classroomId },
    select: {
      id: true,
      displayName: true,
      sisUserId: true,
      sisLoginId: true,
      email: true,
      section: true,
      claimedByUserId: true,
      removedAt: true,
      claimedByUser: { select: { githubLogin: true } },
    },
    orderBy: { displayName: 'asc' },
  })

  // Repository counts per claiming user, so the preview can state exactly what a
  // removal would affect.
  const claimedUserIds = entries
    .map((e) => e.claimedByUserId)
    .filter((id): id is string => id !== null)

  const repoCounts = new Map<string, number>()
  if (claimedUserIds.length > 0) {
    const grouped = await db.assignmentRepo.groupBy({
      by: ['userId'],
      where: { userId: { in: claimedUserIds }, assignment: { classroomId } },
      _count: { _all: true },
    })
    for (const row of grouped) {
      if (row.userId) repoCounts.set(row.userId, row._count._all)
    }
  }

  return entries.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    sisUserId: e.sisUserId,
    sisLoginId: e.sisLoginId,
    email: e.email,
    section: e.section,
    claimedByUserId: e.claimedByUserId,
    claimedByLogin: e.claimedByUser?.githubLogin ?? null,
    removedAt: e.removedAt,
    repoCount: e.claimedByUserId ? (repoCounts.get(e.claimedByUserId) ?? 0) : 0,
  }))
}

function summarize(diff: RosterDiff): RosterPreview['diff'] {
  return {
    added: diff.added.map((a) => ({
      displayName: a.displayName,
      sisUserId: a.sisUserId,
      section: a.section,
    })),
    updated: diff.updated.map((u) => ({
      id: u.existing.id,
      displayName: u.existing.displayName,
      changes: u.changes,
    })),
    unchangedCount: diff.unchanged.length,
    restored: diff.restored.map((r) => ({
      id: r.existing.id,
      displayName: r.existing.displayName,
    })),
    removed: diff.removed.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      claimed: r.claimedByUserId !== null,
    })),
    destructive: diff.destructive.map((d) => ({
      id: d.entry.id,
      displayName: d.entry.displayName,
      consequence: d.consequence,
    })),
    matchedBy: diff.matchedBy,
  }
}

/** Step 1: parse and diff, writing nothing. */
export async function previewRosterImport(
  formData: FormData,
): Promise<RosterPreview | { ok: false; error: string }> {
  const classroomId = String(formData.get('classroomId') ?? '')
  await requireInstructor(classroomId)

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a CSV file exported from Canvas.' }
  }

  // Server actions cap the request body at 1 MB by default; a 1000-student
  // export with assignment columns is well under that, but say so plainly if it
  // is not rather than failing obscurely.
  if (file.size > 4 * 1024 * 1024) {
    return {
      ok: false,
      error:
        'That file is larger than 4 MB. Re-export from Canvas without assignment columns, ' +
        'or split it by section.',
    }
  }

  const csv = await file.text()

  try {
    const parse = parseRosterCsv(csv)
    const existing = await loadExisting(classroomId)
    const diff = diffRoster(parse.rows, existing)

    return {
      ok: true,
      csv,
      fileName: file.name,
      parse: {
        matchedColumns: parse.matchedColumns,
        passthroughColumns: parse.passthroughColumns,
        warnings: parse.warnings,
        skipped: parse.skipped,
        totalRows: parse.rows.length,
      },
      diff: summarize(diff),
    }
  } catch (error) {
    if (error instanceof RosterParseError) return { ok: false, error: error.message }
    throw error
  }
}

/**
 * Step 2: apply. `applyRemovals` is opt-in, because dropping students is the
 * only part of an import that can take away access.
 */
export async function applyRosterImport(
  formData: FormData,
): Promise<RosterActionResult<{ added: number; updated: number; removed: number; restored: number }>> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  const csv = String(formData.get('csv') ?? '')
  if (!csv.trim()) return { ok: false, error: 'The uploaded file is no longer available. Upload it again.' }

  const applyRemovals = formData.get('applyRemovals') === 'on'

  let diff: RosterDiff
  try {
    // Re-derived, not taken from the client: this determines who loses access.
    const parse = parseRosterCsv(csv)
    diff = diffRoster(parse.rows, await loadExisting(classroomId))
  } catch (error) {
    if (error instanceof RosterParseError) return { ok: false, error: error.message }
    throw error
  }

  const operations: Prisma.PrismaPromise<unknown>[] = []

  for (const row of diff.added) {
    operations.push(
      db.rosterEntry.create({
        data: {
          classroomId,
          displayName: row.displayName,
          sisUserId: row.sisUserId,
          sisLoginId: row.sisLoginId,
          email: row.email,
          section: row.section,
          rawColumns: row.rawColumns as Prisma.InputJsonValue,
        },
      }),
    )
  }

  for (const { existing, parsed } of [...diff.updated, ...diff.restored]) {
    operations.push(
      db.rosterEntry.update({
        where: { id: existing.id },
        data: {
          displayName: parsed.displayName,
          // Only overwrite when the CSV actually carries a value, so an export
          // missing SIS columns cannot blank out data we already hold.
          ...(parsed.sisUserId ? { sisUserId: parsed.sisUserId } : {}),
          ...(parsed.sisLoginId ? { sisLoginId: parsed.sisLoginId } : {}),
          ...(parsed.email ? { email: parsed.email } : {}),
          ...(parsed.section ? { section: parsed.section } : {}),
          rawColumns: parsed.rawColumns as Prisma.InputJsonValue,
          // Restores clear the soft-delete, preserving the student's claim.
          removedAt: null,
        },
      }),
    )
  }

  if (applyRemovals) {
    for (const entry of diff.removed) {
      // Soft delete: the claim, and therefore the link to any provisioned
      // repository, is preserved so a mistaken import is recoverable.
      operations.push(
        db.rosterEntry.update({
          where: { id: entry.id },
          data: { removedAt: new Date() },
        }),
      )
    }
  }

  await db.$transaction(operations)

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'roster.import',
      targetType: 'classroom',
      targetId: classroomId,
      detail: {
        added: diff.added.length,
        updated: diff.updated.length,
        restored: diff.restored.length,
        removed: applyRemovals ? diff.removed.length : 0,
        removalsSkipped: applyRemovals ? 0 : diff.removed.length,
        destructiveCount: diff.destructive.length,
        matchedBy: diff.matchedBy,
      },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/roster`)
  revalidatePath(`/classrooms/${classroom.slug}`)

  return {
    ok: true,
    data: {
      added: diff.added.length,
      updated: diff.updated.length + diff.restored.length,
      removed: applyRemovals ? diff.removed.length : 0,
      restored: diff.restored.length,
    },
  }
}

/** Detach a student's GitHub account from a roster entry, freeing it to reclaim. */
export async function unlinkRosterEntry(
  formData: FormData,
): Promise<RosterActionResult> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const entryId = String(formData.get('entryId') ?? '')
  const { user, classroom } = await requireInstructor(classroomId)

  const entry = await db.rosterEntry.findFirst({
    where: { id: entryId, classroomId },
    select: { id: true, displayName: true, claimedByUserId: true },
  })
  if (!entry) return { ok: false, error: 'That roster entry no longer exists.' }
  if (!entry.claimedByUserId) return { ok: false, error: 'That entry is not linked to anyone.' }

  await db.rosterEntry.update({
    where: { id: entry.id },
    data: { claimedByUserId: null, claimedAt: null },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: 'roster.unlink',
      targetType: 'rosterEntry',
      targetId: entry.id,
      detail: { displayName: entry.displayName, previousUserId: entry.claimedByUserId },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/roster`)
  return { ok: true, data: undefined }
}

/** Soft-remove or restore a single roster entry. */
export async function setRosterEntryRemoved(
  formData: FormData,
): Promise<RosterActionResult> {
  const classroomId = String(formData.get('classroomId') ?? '')
  const entryId = String(formData.get('entryId') ?? '')
  const removed = formData.get('removed') === 'true'
  const { user, classroom } = await requireInstructor(classroomId)

  const entry = await db.rosterEntry.findFirst({
    where: { id: entryId, classroomId },
    select: { id: true, displayName: true },
  })
  if (!entry) return { ok: false, error: 'That roster entry no longer exists.' }

  await db.rosterEntry.update({
    where: { id: entry.id },
    data: { removedAt: removed ? new Date() : null },
  })

  await db.auditLog.create({
    data: {
      classroomId,
      actorUserId: user.id,
      action: removed ? 'roster.remove' : 'roster.restore',
      targetType: 'rosterEntry',
      targetId: entry.id,
      detail: { displayName: entry.displayName },
    },
  })

  revalidatePath(`/classrooms/${classroom.slug}/roster`)
  return { ok: true, data: undefined }
}
