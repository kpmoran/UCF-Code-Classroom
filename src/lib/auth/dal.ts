import 'server-only'

import { ClassroomRole } from '@prisma/client'
import { forbidden, notFound, redirect } from 'next/navigation'
import { cache } from 'react'

import { auth } from './config'
import { roleSatisfies } from './roles'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

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
  /** Effective, not the raw column — see getCurrentUser. */
  isSiteAdmin: boolean
  /** May create classrooms. Effective: implied by isSiteAdmin. */
  isFaculty: boolean
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
      isFaculty: true,
    },
  })
  if (!user) return null

  /**
   * Admin status is the column OR the SITE_ADMIN_LOGINS configuration, and faculty
   * status is implied by admin.
   *
   * Configuration is consulted on every request rather than copied into the row, so
   * granting or revoking an admin is a deploy rather than a database edit, and there
   * is no stale row to notice. It also solves the bootstrap: a fresh deployment has
   * no users, so nobody could otherwise grant the first one anything.
   */
  const login = user.githubLogin?.toLowerCase()
  const isSiteAdmin =
    user.isSiteAdmin || (login !== undefined && env.SITE_ADMIN_LOGINS.includes(login))

  return { ...user, isSiteAdmin, isFaculty: user.isFaculty || isSiteAdmin }
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
  /**
   * True when the role came from the site-admin bypass rather than membership.
   * Callers showing student data must refuse in that case.
   */
  viaSiteAdmin: boolean
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

    /*
     * Site admins can administer any classroom without joining it: the break-glass
     * path for support and for recovering a classroom whose instructor left.
     *
     * `viaSiteAdmin` records that the role came from that bypass rather than from
     * membership, because the two should not grant the same things. Operating an
     * instance is a reason to reach a classroom's configuration; it is not a reason
     * to read a colleague's students' names, addresses and grades. Pages that show
     * student data use `requireEnrolledStaff` below, which refuses the bypass.
     */
    const viaSiteAdmin = !membership && user.isSiteAdmin
    const effectiveRole = membership?.role ?? (viaSiteAdmin ? ClassroomRole.INSTRUCTOR : null)

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
    return { user, role: effectiveRole, classroom: rest, viaSiteAdmin }
  },
)

/** Convenience wrappers, so call sites read as the permission they need. */
/**
 * The signed-in user, provided they may create classrooms.
 *
 * `forbidden()` rather than a redirect: they are signed in and the answer will not
 * change by signing in again, so sending them back to /signin would be a loop with
 * extra steps.
 */
export const requireFaculty = cache(async (): Promise<SessionUser> => {
  const user = await requireUser()
  if (!user.isFaculty) forbidden()
  return user
})

/** The signed-in user, provided they administer the whole site. */
export const requireSiteAdmin = cache(async (): Promise<SessionUser> => {
  const user = await requireUser()
  if (!user.isSiteAdmin) forbidden()
  return user
})

export const requireInstructor = (classroomIdOrSlug: string) =>
  requireClassroomRole(classroomIdOrSlug, ClassroomRole.INSTRUCTOR)

export const requireStaff = (classroomIdOrSlug: string) =>
  requireClassroomRole(classroomIdOrSlug, ClassroomRole.TA)

/**
 * Staff of this classroom *by membership* — the site-admin bypass is not enough.
 *
 * For anything listing students: the roster, grades, the per-assignment table, the
 * activity log. Administering an instance does not come with a standing right to
 * read every course's student records, and a site admin who genuinely needs in can
 * add themselves as an instructor from /admin/classrooms, which is one click and
 * leaves an audit entry naming them.
 *
 * `forbidden()`, not `notFound()`: they can already see the classroom exists from
 * the admin listing, so pretending otherwise would only be confusing.
 */
const requireEnrolled = async (classroomIdOrSlug: string, required: ClassroomRole) => {
  const context = await requireClassroomRole(classroomIdOrSlug, required)
  if (context.viaSiteAdmin) forbidden()
  return context
}

export const requireEnrolledStaff = (classroomIdOrSlug: string) =>
  requireEnrolled(classroomIdOrSlug, ClassroomRole.TA)

/**
 * As above, but instructor-only. The membership requirement and the role
 * requirement are independent, and the activity log needs both: it names students
 * alongside the actions taken on them, so it is not for TAs, and it is not for an
 * admin who has not joined.
 */
export const requireEnrolledInstructor = (classroomIdOrSlug: string) =>
  requireEnrolled(classroomIdOrSlug, ClassroomRole.INSTRUCTOR)

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
