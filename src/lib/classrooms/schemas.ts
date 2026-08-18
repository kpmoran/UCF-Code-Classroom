import { z } from 'zod'

/**
 * Validation shared by the classroom forms and their server actions.
 *
 * Defined once so the server never trusts a shape the client happened to send;
 * server actions are a public HTTP endpoint regardless of which form calls them.
 */

export const createClassroomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, 'Give the classroom a name of at least 3 characters.')
    .max(200, 'Keep the name under 200 characters.'),
  courseCode: z
    .string()
    .trim()
    .max(30, 'Keep the course code under 30 characters.')
    .optional()
    .transform((v) => (v ? v : null)),
  term: z
    .string()
    .trim()
    .max(50, 'Keep the term under 50 characters.')
    .optional()
    .transform((v) => (v ? v : null)),
  // Which GitHub App installation (i.e. which organization) backs this
  // classroom. Sent as a string because form data carries no numbers.
  installationId: z
    .string()
    .min(1, 'Choose the GitHub organization for this classroom.')
    .regex(/^\d+$/, 'Invalid installation.'),
})

export type CreateClassroomInput = z.infer<typeof createClassroomSchema>

export const updateClassroomSchema = z.object({
  classroomId: z.string().min(1),
  name: z.string().trim().min(3).max(200),
  courseCode: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => (v ? v : null)),
  term: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((v) => (v ? v : null)),
  defaultRepoVisibility: z.enum(['PRIVATE', 'PUBLIC']),
  defaultStudentPermission: z.enum(['PULL', 'PUSH', 'MAINTAIN', 'ADMIN']),
})

export const archiveClassroomSchema = z.object({
  classroomId: z.string().min(1),
  // Typed confirmation: archiving hides a classroom from every student, so it
  // must not be reachable by a stray click.
  confirmSlug: z.string().min(1),
  archive: z.enum(['true', 'false']),
})

/** Shape returned by every classroom action, for consistent form handling. */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
