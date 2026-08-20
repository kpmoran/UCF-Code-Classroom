import Link from 'next/link'
import { Suspense } from 'react'

import { AddStudentForm } from '@/components/add-student-form'
import { ArchiveForm } from '@/components/archive-classroom-form'
import {
  OrgOwnershipPanel,
  OrgOwnershipSkeleton,
} from '@/components/classroom-org-panel'
import { ClassroomOwnerPanel } from '@/components/classroom-owner-panel'
import { ClassroomSettingsForm } from '@/components/classroom-settings-form'
import { InviteLinkPanel } from '@/components/invite-link-panel'
import { SiteHeader } from '@/components/site-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export default async function ClassroomSettingsPage(
  props: PageProps<'/classrooms/[slug]/settings'>,
) {
  const { slug } = await props.params
  const { classroom, user } = await requireInstructor(slug)

  const [full, inviteLink] = await Promise.all([
    db.classroom.findUniqueOrThrow({
      where: { id: classroom.id },
      select: {
        id: true,
        name: true,
        slug: true,
        courseCode: true,
        term: true,
        defaultRepoVisibility: true,
        defaultStudentPermission: true,
        archivedAt: true,
        githubOrgLogin: true,
        installationId: true,
      },
    }),
    db.inviteLink.findFirst({
      where: { classroomId: classroom.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { token: true, useCount: true, expiresAt: true, maxUses: true },
    }),
  ])

  const joinUrl = inviteLink
    ? `${env.APP_URL.replace(/\/$/, '')}/join/${inviteLink.token}`
    : null

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-3xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${full.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {full.name}
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Classroom settings</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>GitHub organization</CardTitle>
            <CardDescription>
              Fixed for the life of the classroom — repositories already live here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {/* Streamed: asking GitHub who you are must not hold up the settings
                form or the archive controls, which do not depend on the answer. */}
            <Suspense fallback={<OrgOwnershipSkeleton orgLogin={full.githubOrgLogin} />}>
              <OrgOwnershipPanel
                installationId={full.installationId}
                orgLogin={full.githubOrgLogin}
                githubLogin={user.githubLogin}
              />
            </Suspense>
          </CardContent>
        </Card>

        <ClassroomOwnerPanel
          classroomId={full.id}
          slug={full.slug}
          orgLogin={full.githubOrgLogin}
        />

        <ClassroomSettingsForm
          classroom={{
            id: full.id,
            name: full.name,
            courseCode: full.courseCode,
            term: full.term,
            defaultRepoVisibility: full.defaultRepoVisibility,
            defaultStudentPermission: full.defaultStudentPermission,
          }}
        />

        <InviteLinkPanel
          classroomId={full.id}
          joinUrl={joinUrl}
          useCount={inviteLink?.useCount ?? 0}
        />

        <Card>
          <CardHeader>
            <CardTitle>Add a student</CardTitle>
            <CardDescription>
              For someone a Canvas export does not cover yet — a late add, an auditing
              student, a section run out of another shell. Adds them to the roster so they can
              claim their own entry through the invite link;{' '}
              <Link href={`/classrooms/${full.slug}/roster`} className="underline">
                import a CSV
              </Link>{' '}
              instead when you have the whole list.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddStudentForm
              classroomId={full.id}
              slug={full.slug}
              archived={full.archivedAt !== null}
            />
          </CardContent>
        </Card>

        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">
              {full.archivedAt ? 'Restore classroom' : 'Archive classroom'}
            </CardTitle>
            <CardDescription>
              {full.archivedAt
                ? 'Re-enable new assignments and registrations.'
                : 'Disables new assignments and registrations. Existing GitHub repositories are left completely untouched.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ArchiveForm
              classroomId={full.id}
              slug={full.slug}
              archived={Boolean(full.archivedAt)}
            />
          </CardContent>
        </Card>
      </main>
    </>
  )
}
