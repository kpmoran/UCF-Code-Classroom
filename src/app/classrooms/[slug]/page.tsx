import Link from 'next/link'

import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/table'
import { InviteLinkBar } from '@/components/invite-link-panel'
import { OrgInvitationNotice } from '@/components/org-invitation-notice'
import { requireClassroomRole } from '@/lib/auth/dal'
import { ROLE_LABEL, roleSatisfies } from '@/lib/auth/roles'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { reconcileOrgMemberships } from '@/lib/students/orgAccess'
import { effectiveOrgState } from '@/lib/students/orgRules'

export default async function ClassroomPage(props: PageProps<'/classrooms/[slug]'>) {
  const { slug } = await props.params
  const search = await props.searchParams
  const { classroom, role, user } = await requireClassroomRole(slug)

  const isStaff = roleSatisfies(role, 'TA')

  const [assignments, rosterCount, claimedCount, memberCount, inviteLink, orgNotice] = await Promise.all([
    db.assignment.findMany({
      where: {
        classroomId: classroom.id,
        // Students only see published assignments.
        ...(isStaff ? {} : { publishedAt: { not: null } }),
      },
      orderBy: [{ deadline: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        slug: true,
        type: true,
        deadline: true,
        publishedAt: true,
        _count: { select: { repos: true } },
      },
    }),
    db.rosterEntry.count({ where: { classroomId: classroom.id, removedAt: null } }),
    db.rosterEntry.count({
      where: { classroomId: classroom.id, removedAt: null, claimedByUserId: { not: null } },
    }),
    db.classroomMember.count({ where: { classroomId: classroom.id } }),
    // Only for staff; students already used the link to get here.
    isStaff
      ? db.inviteLink.findFirst({
          where: { classroomId: classroom.id, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { token: true, useCount: true },
        })
      : null,
    isStaff ? null : studentOrgNotice(classroom.id, user.id),
  ])

  const joinUrl = inviteLink
    ? `${env.APP_URL.replace(/\/$/, '')}/join/${inviteLink.token}`
    : null

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
        <div>
          <Link href="/" className="text-sm text-muted hover:underline">
            ← Classrooms
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">{classroom.name}</h1>
              <p className="text-sm text-muted mt-1">
                {[classroom.courseCode, classroom.term].filter(Boolean).join(' · ') ||
                  'No course code'}
                {' · '}
                <a
                  href={`https://github.com/${classroom.githubOrgLogin}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs hover:underline"
                >
                  {classroom.githubOrgLogin}
                </a>
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge tone={role === 'STUDENT' ? 'neutral' : 'info'}>{ROLE_LABEL[role]}</Badge>
              {classroom.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
              {isStaff ? (
                <>
                  <ButtonLink
                    href={`/classrooms/${classroom.slug}/roster`}
                    variant="outline"
                    size="sm"
                  >
                    Roster
                  </ButtonLink>
                  <ButtonLink
                    href={`/classrooms/${classroom.slug}/people`}
                    variant="outline"
                    size="sm"
                  >
                    People
                  </ButtonLink>
                  <ButtonLink
                    href={`/classrooms/${classroom.slug}/grades`}
                    variant="outline"
                    size="sm"
                  >
                    Grades
                  </ButtonLink>
                  {role === 'INSTRUCTOR' ? (
                    <ButtonLink
                      href={`/classrooms/${classroom.slug}/settings`}
                      variant="outline"
                      size="sm"
                    >
                      Settings
                    </ButtonLink>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>

        {isStaff && !classroom.archivedAt ? (
          <InviteLinkBar
            joinUrl={joinUrl}
            useCount={inviteLink?.useCount ?? 0}
            settingsHref={`/classrooms/${classroom.slug}/settings`}
          />
        ) : null}

        {search.notOwner ? (
          <div
            role="alert"
            className="rounded-md bg-warning-subtle text-warning px-4 py-3 text-sm"
          >
            <p className="font-medium">
              You may not be an Owner of {classroom.githubOrgLogin}.
            </p>
            <p className="mt-1">
              Individual assignments will work. Group assignments create GitHub teams, which
              can require organization Owner rights — check your role in the organization’s
              People settings if team invitations fail.
            </p>
          </div>
        ) : null}

        {orgNotice && !classroom.archivedAt ? (
          <OrgInvitationNotice
            classroomId={classroom.id}
            orgLogin={classroom.githubOrgLogin}
            state={orgNotice}
          />
        ) : null}

        {classroom.archivedAt ? (
          <div className="rounded-md bg-surface-subtle border border-border px-4 py-3 text-sm text-muted">
            This classroom is archived. Existing repositories are untouched, but new
            assignments and registrations are disabled.
          </div>
        ) : null}

        {isStaff ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="py-4">
                <p className="text-2xl font-semibold">{rosterCount}</p>
                <p className="text-sm text-muted">on roster</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-2xl font-semibold">{claimedCount}</p>
                <p className="text-sm text-muted">
                  linked their GitHub
                  {rosterCount > 0 ? ` (${Math.round((claimedCount / rosterCount) * 100)}%)` : ''}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-2xl font-semibold">{memberCount}</p>
                <p className="text-sm text-muted">classroom members</p>
              </CardContent>
            </Card>
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Assignments</h2>
            {isStaff && !classroom.archivedAt ? (
              <ButtonLink
                href={`/classrooms/${classroom.slug}/assignments/new`}
                variant="accent"
                size="sm"
              >
                New assignment
              </ButtonLink>
            ) : null}
          </div>

          {assignments.length === 0 ? (
            <Card>
              <EmptyState
                title="No assignments yet"
                description={
                  isStaff
                    ? 'Create an assignment from a template repository to get started.'
                    : 'Your instructor has not published any assignments yet.'
                }
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {assignments.map((a) => (
                <Card key={a.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate">
                          <Link
                            href={`/classrooms/${classroom.slug}/assignments/${a.id}`}
                            className="hover:underline"
                          >
                            {a.title}
                          </Link>
                        </CardTitle>
                        <CardDescription>
                          {a.type === 'GROUP' ? 'Group assignment' : 'Individual assignment'}
                          {a.deadline
                            ? ` · due ${a.deadline.toLocaleString('en-US', {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}`
                            : ' · no deadline'}
                        </CardDescription>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        {!a.publishedAt ? <Badge tone="warning">Draft</Badge> : null}
                        {isStaff ? (
                          <span className="text-xs text-muted">
                            {a._count.repos} repo{a._count.repos === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  )
}

/**
 * Whether a student's organization invitation still needs their attention.
 *
 * Asks GitHub once about a pending invitation, because acceptance tells this app
 * nothing: a student who accepted an hour ago should not still be told to. Only
 * their own row, and only while it is pending, so the read stops once it clears.
 */
async function studentOrgNotice(
  classroomId: string,
  userId: string,
): Promise<'pending' | 'expired' | null> {
  const [settings, member] = await Promise.all([
    db.classroom.findUniqueOrThrow({
      where: { id: classroomId },
      select: { studentOrgAccess: true },
    }),
    db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId, userId } },
      select: { id: true, role: true, orgState: true, orgInvitedAt: true },
    }),
  ])
  if (!settings.studentOrgAccess || member?.role !== 'STUDENT') return null

  const state = effectiveOrgState(member.orgState, member.orgInvitedAt, new Date())
  if (state === 'pending') {
    const { activated } = await reconcileOrgMemberships(classroomId, {
      classroomMemberId: member.id,
    })
    return activated > 0 ? null : 'pending'
  }
  return state === 'expired' ? 'expired' : null
}
