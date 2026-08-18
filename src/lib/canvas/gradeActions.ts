'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'

export type GradeActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const manualScoreSchema = z.object({
  assignmentRepoId: z.string().min(1),
  // Empty string clears the override and returns to the autograded score.
  score: z.string(),
  note: z.string().trim().max(500).optional(),
})

/**
 * Set or clear a manual score override.
 *
 * The override always wins over autograding on export, because it exists precisely
 * for the cases the automatic number gets wrong — a partially working submission, a
 * demo done in person, an academic-integrity adjustment.
 */
export async function setManualScore(formData: FormData): Promise<GradeActionResult> {
  const parsed = manualScoreSchema.safeParse({
    assignmentRepoId: formData.get('assignmentRepoId'),
    score: formData.get('score') ?? '',
    note: formData.get('note') ?? undefined,
  })
  if (!parsed.success) return { ok: false, error: 'Invalid request.' }

  const repo = await db.assignmentRepo.findUnique({
    where: { id: parsed.data.assignmentRepoId },
    select: {
      id: true,
      fullName: true,
      assignment: {
        select: {
          id: true,
          title: true,
          classroomId: true,
          classroom: { select: { slug: true } },
        },
      },
    },
  })
  if (!repo) return { ok: false, error: 'That repository record no longer exists.' }

  const { user } = await requireInstructor(repo.assignment.classroomId)

  const raw = parsed.data.score.trim()
  let score: number | null = null

  if (raw !== '') {
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Enter a number, or leave it empty to clear the override.' }
    }
    if (value < 0) return { ok: false, error: 'A score cannot be negative.' }
    if (value > 100_000) return { ok: false, error: 'That score is implausibly large.' }
    score = Math.round(value)
  }

  await db.assignmentRepo.update({
    where: { id: repo.id },
    data: { manualScore: score, manualScoreNote: parsed.data.note ?? null },
  })

  await db.auditLog.create({
    data: {
      classroomId: repo.assignment.classroomId,
      actorUserId: user.id,
      action: score === null ? 'grade.override_clear' : 'grade.override_set',
      targetType: 'assignmentRepo',
      targetId: repo.id,
      detail: {
        assignment: repo.assignment.title,
        repo: repo.fullName,
        score,
        note: parsed.data.note ?? null,
      },
    },
  })

  revalidatePath(
    `/classrooms/${repo.assignment.classroom.slug}/assignments/${repo.assignment.id}`,
  )
  revalidatePath(`/classrooms/${repo.assignment.classroom.slug}/grades`)
  return { ok: true, data: undefined }
}
