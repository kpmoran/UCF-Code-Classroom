import { z } from 'zod'

/** Shared shape for assignment action results. */
export type AssignmentActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null))

export const createAssignmentSchema = z.object({
  classroomId: z.string().min(1),
  title: z
    .string()
    .trim()
    .min(3, 'Give the assignment a title of at least 3 characters.')
    .max(200, 'Keep the title under 200 characters.'),
  type: z.enum(['INDIVIDUAL', 'GROUP']),

  // Accepts "owner/repo" or a full GitHub URL, normalized by the action.
  template: z
    .string()
    .trim()
    .min(3, 'Choose or enter a template repository.')
    .max(300),

  repoPrefix: z
    .string()
    .trim()
    .min(1, 'A repository prefix is required.')
    .max(60, 'Keep the prefix under 60 characters.')
    // Enforced here as well as sanitized later, so the instructor sees the rule
    // rather than a silently altered prefix on every student repository.
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9-_.]*$/,
      'Use only letters, numbers, hyphens, underscores and periods, starting with a letter or number.',
    ),

  visibility: z.enum(['PRIVATE', 'PUBLIC']),
  studentPermission: z.enum(['PULL', 'PUSH', 'MAINTAIN', 'ADMIN']),

  // datetime-local sends "YYYY-MM-DDTHH:mm" with no zone; interpreted as the
  // server's local time, which is the instructor's expectation.
  deadline: optionalText(40),
  lockOnDeadline: z.coerce.boolean().default(false),
  feedbackPrEnabled: z.coerce.boolean().default(false),
  autogradeEnabled: z.coerce.boolean().default(false),

  maxTeams: z.coerce.number().int().min(1).max(500).optional(),
  maxTeamSize: z.coerce.number().int().min(1).max(50).optional(),

  publish: z.coerce.boolean().default(false),
})

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>

/**
 * Normalize a template reference.
 *
 * Instructors paste whatever they have: a full URL from the browser bar, an
 * `owner/repo` pair, or the bare repo name of something in their own org.
 */
export function parseTemplateReference(
  input: string,
  defaultOwner: string,
): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '')
  if (!trimmed) return null

  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i,
  )
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] }

  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 2) return { owner: parts[0], repo: parts[1] }
  if (parts.length === 1) return { owner: defaultOwner, repo: parts[0] }

  return null
}

/**
 * Parse a `datetime-local` value into a Date.
 *
 * Returns null for an empty value and undefined for an unparseable one, so the
 * caller can tell "no deadline" from "the instructor typed something wrong" —
 * silently dropping a bad deadline would leave an assignment permanently open.
 */
export function parseDeadline(value: string | null): Date | null | undefined {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date
}
