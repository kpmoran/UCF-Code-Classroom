import { ClassroomRole } from '@prisma/client'

/**
 * Role hierarchy. An INSTRUCTOR satisfies a TA requirement, and both satisfy
 * STUDENT. Comparing ranks avoids the bug where a check for `role === 'TA'`
 * accidentally locks the instructor out of their own console.
 *
 * Kept free of imports beyond the generated enum so it can be unit tested and
 * reused from anywhere, including client components.
 */
export const ROLE_RANK: Record<ClassroomRole, number> = {
  [ClassroomRole.STUDENT]: 1,
  [ClassroomRole.TA]: 2,
  [ClassroomRole.INSTRUCTOR]: 3,
}

export function roleSatisfies(actual: ClassroomRole, required: ClassroomRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

export const ROLE_LABEL: Record<ClassroomRole, string> = {
  [ClassroomRole.STUDENT]: 'Student',
  [ClassroomRole.TA]: 'TA',
  [ClassroomRole.INSTRUCTOR]: 'Instructor',
}
