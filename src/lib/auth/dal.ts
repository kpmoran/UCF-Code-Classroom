import 'server-only'

import { ClassroomRole } from '@prisma/client'
import { forbidden, notFound, redirect } from 'next/navigation'
import { cache } from 'react'

import { auth } from './config'
import { roleSatisfies } from './roles'
import { db } from '@/lib/db'

/**
 * Data access layer.
 *
 * This is the authorization boundary. `proxy.ts` performs optimistic redirects
 * only — it can be wrong about a stale cookie and it never reads the database.
 * Every page, server action, and route handler that touches classroom data must
 * call one of the `require*` functions here, so a missing check is a missing
 * call at the point of use rather than a silent gap in a route matcher.
 *
 * All functions are wrapped in React's `cache` so calling them repeatedly
 * within one render pass costs a single query.
 */

export type SessionUser = {
  id: string
  name: string | null
  email: string | null
  image: string | null
  githubLogin: string | null
  isSiteAdmin: boolean
}

/** The signed-in user, or null. Use when unauthenticated access is valid. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth()
  if (!session?.user?.id) return null

  // Read through to the database rather than trusting the session copy: role
  // and admin changes must take effect without waiting for a new session.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      githubLogin: true,
      isSiteAdmin: true,
    },
  })

  return user
})

/** The signed-in user, redirecting to sign-in if there is none. */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await getCurrentUser()
  if (!user) redirect('/signin')
  return user
})

export type ClassroomContext = {
  user: SessionUser
  role: ClassroomRole
  classroom: {
    id: string
    slug: string
    name: string
    courseCode: string | null
    term: string | null
    githubOrgLogin: string
    githubOrgId: bigint
    installationId: bigint
    ownerTokenUserId: string | null
    archivedAt: Date | null
  }
}

/**
 * Assert that the current user holds at least `required` in the classroom,
 * returning the classroom and their effective role.
 *
 * Accepts either a classroom id or slug so callers can use whichever the route
 * gives them without a preliminary lookup.
 */
export const requireClassroomRole = cache(
  async (
    classroomIdOrSlug: string,
    required: ClassroomRole = ClassroomRole.STUDENT,
  ): Promise<ClassroomContext> => {
    const user = await requireUser()

    const classroom = await db.classroom.findFirst({
      where: {
        OR: [{ id: classroomIdOrSlug }, { slug: classroomIdOrSlug }],
      },
      select: {
        id: true,
        slug: true,
        name: true,
        courseCode: true,
        term: true,
        githubOrgLogin: true,
        githubOrgId: true,
        installationId: true,
        ownerTokenUserId: true,
        archivedAt: true,
        members: {
          where: { userId: user.id },
          select: { role: true },
          take: 1,
        },
      },
    })

    if (!classroom) notFound()

    const membership = classroom.members[0]

    // Site admins can administer any classroom; this is the break-glass path
    // for support and for recovering a classroom whose instructor left.
    const effectiveRole = membership?.role ?? (user.isSiteAdmin ? ClassroomRole.INSTRUCTOR : null)

    // Non-members get 404, not 403: otherwise the response code confirms that
    // a given classroom slug exists, across every course on the instance.
    if (!effectiveRole) notFound()

    // A member who lacks the required role does get 403 — they already know the
    // classroom exists, and "you are a student here, not staff" is the useful
    // message.
    if (!roleSatisfies(effectiveRole, required)) forbidden()

    // Drop the membership rows; callers get the resolved `role` instead.
    const { members, ...rest } = classroom
    void members
    return { user, role: effectiveRole, classroom: rest }
  },
)

/** Convenience wrappers, so call sites read as the permission they need. */
export const requireInstructor = (classroomIdOrSlug: string) =>
  requireClassroomRole(classroomIdOrSlug, ClassroomRole.INSTRUCTOR)

export const requireStaff = (classroomIdOrSlug: string) =>
  requireClassroomRole(classroomIdOrSlug, ClassroomRole.TA)

/** Classrooms the current user belongs to, for the dashboard. */
export const listMyClassrooms = cache(async () => {
  const user = await requireUser()
  return db.classroomMember.findMany({
    where: { userId: user.id },
    select: {
      role: true,
      classroom: {
        select: {
          id: true,
          slug: true,
          name: true,
          courseCode: true,
          term: true,
          archivedAt: true,
          githubOrgLogin: true,
          _count: { select: { rosterEntries: true, assignments: true } },
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
  })
})
