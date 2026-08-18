import Link from 'next/link'

import { RosterImportPanel } from '@/components/roster-import-panel'
import { RosterTable } from '@/components/roster-table'
import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'
import { requireStaff } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export default async function RosterPage(props: PageProps<'/classrooms/[slug]/roster'>) {
  const { slug } = await props.params
  const { classroom, role } = await requireStaff(slug)

  const [entries, inviteLink] = await Promise.all([
    db.rosterEntry.findMany({
      where: { classroomId: classroom.id },
      select: {
        id: true,
        displayName: true,
        sisUserId: true,
        sisLoginId: true,
        email: true,
        section: true,
        claimedAt: true,
        removedAt: true,
        claimedByUser: { select: { githubLogin: true, name: true } },
      },
      orderBy: [{ removedAt: 'asc' }, { displayName: 'asc' }],
    }),
    db.inviteLink.findFirst({
      where: { classroomId: classroom.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { token: true },
    }),
  ])

  const active = entries.filter((e) => !e.removedAt)
  const claimed = active.filter((e) => e.claimedByUser !== null)

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div>
              <h1 className="text-2xl font-semibold">Roster</h1>
              <p className="text-sm text-muted mt-1">
                {active.length} active · {claimed.length} linked their GitHub account
                {entries.length !== active.length
                  ? ` · ${entries.length - active.length} removed`
                  : ''}
              </p>
            </div>
            {role === 'INSTRUCTOR' ? (
              <ButtonLink
                href={`/classrooms/${classroom.slug}/settings`}
                variant="outline"
                size="sm"
              >
                Settings
              </ButtonLink>
            ) : null}
          </div>
        </div>

        {inviteLink ? (
          <div className="rounded-md border border-border bg-surface-subtle px-4 py-3 text-sm">
            <span className="text-muted">Invite link: </span>
            <code className="font-mono text-xs break-all">
              {`${env.APP_URL.replace(/\/$/, '')}/join/${inviteLink.token}`}
            </code>
          </div>
        ) : null}

        {role === 'INSTRUCTOR' ? (
          <RosterImportPanel classroomId={classroom.id} hasExisting={active.length > 0} />
        ) : null}

        <RosterTable
          classroomId={classroom.id}
          canManage={role === 'INSTRUCTOR'}
          entries={entries.map((e) => ({
            id: e.id,
            displayName: e.displayName,
            sisUserId: e.sisUserId,
            sisLoginId: e.sisLoginId,
            email: e.email,
            section: e.section,
            githubLogin: e.claimedByUser?.githubLogin ?? null,
            claimedAt: e.claimedAt ? e.claimedAt.toISOString() : null,
            removed: e.removedAt !== null,
          }))}
        />
      </main>
    </>
  )
}
