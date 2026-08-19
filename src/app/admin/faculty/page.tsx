import Link from 'next/link'

import { FacultyInvitePanel } from '@/components/faculty-invite-panel'
import { SiteHeader } from '@/components/site-header'
import { requireSiteAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export default async function AdminFacultyPage() {
  await requireSiteAdmin()

  const [invites, facultyUsers] = await Promise.all([
    db.facultyInvite.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        note: true,
        maxUses: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        _count: { select: { redemptions: true } },
      },
    }),
    // Anyone who can create a classroom: the flag, or an admin. Configuration-listed
    // admins may have no row-level flag at all, so they are folded in below rather
    // than queried for.
    db.user.findMany({
      where: { OR: [{ isFaculty: true }, { isSiteAdmin: true }] },
      orderBy: [{ isSiteAdmin: 'desc' }, { githubLogin: 'asc' }],
      select: {
        id: true,
        name: true,
        githubLogin: true,
        isSiteAdmin: true,
        _count: { select: { classroomMembers: true } },
      },
    }),
  ])

  const configLogins = new Set(env.SITE_ADMIN_LOGINS)

  // Admins named in configuration but with neither flag set would otherwise be
  // invisible here, which would make this page lie about who has access.
  const fromConfig = await db.user.findMany({
    where: {
      githubLogin: { in: env.SITE_ADMIN_LOGINS, mode: 'insensitive' },
      isFaculty: false,
      isSiteAdmin: false,
    },
    select: {
      id: true,
      name: true,
      githubLogin: true,
      isSiteAdmin: true,
      _count: { select: { classroomMembers: true } },
    },
  })

  const faculty = [...facultyUsers, ...fromConfig].map((u) => ({
    id: u.id,
    name: u.name,
    githubLogin: u.githubLogin,
    isSiteAdmin: u.isSiteAdmin,
    fromConfig: u.githubLogin !== null && configLogins.has(u.githubLogin.toLowerCase()),
    classrooms: u._count.classroomMembers,
  }))

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-8 space-y-6">
        <div>
          <Link href="/" className="text-sm text-muted hover:underline">
            ← Classrooms
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Faculty access</h1>
          <p className="text-sm text-muted mt-1">
            Who may create classrooms, and the invitations outstanding.
          </p>
        </div>

        <FacultyInvitePanel
          invites={invites.map((i) => ({
            id: i.id,
            note: i.note,
            maxUses: i.maxUses,
            used: i._count.redemptions,
            expiresAt: i.expiresAt?.toISOString() ?? null,
            revokedAt: i.revokedAt?.toISOString() ?? null,
            createdAt: i.createdAt.toISOString(),
          }))}
          faculty={faculty}
          appUrl={env.APP_URL}
        />
      </main>
    </>
  )
}
