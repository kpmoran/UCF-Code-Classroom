import Link from 'next/link'

import { NewAssignmentForm } from '@/components/new-assignment-form'
import { SiteHeader } from '@/components/site-header'
import { requireInstructor } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { listTemplateRepos } from '@/lib/github/operations/repos'

export default async function NewAssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/new'>,
) {
  const { slug } = await props.params
  const { classroom } = await requireInstructor(slug)

  const [defaults, templates] = await Promise.all([
    db.classroom.findUniqueOrThrow({
      where: { id: classroom.id },
      select: { defaultRepoVisibility: true, defaultStudentPermission: true },
    }),
    // Best effort: the form falls back to a free-text field, so a GitHub outage
    // must not block creating an assignment.
    listTemplateRepos(classroom.installationId, classroom.githubOrgLogin).catch(() => []),
  ])

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-2xl px-6 py-8">
        <div className="mb-6">
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <h1 className="text-2xl font-semibold mt-2">New assignment</h1>
          <p className="text-sm text-muted mt-1">
            Each student gets their own copy of a template repository in{' '}
            <span className="font-mono text-xs">{classroom.githubOrgLogin}</span>.
          </p>
        </div>

        <NewAssignmentForm
          classroomId={classroom.id}
          orgLogin={classroom.githubOrgLogin}
          defaultVisibility={defaults.defaultRepoVisibility}
          defaultStudentPermission={defaults.defaultStudentPermission}
          templates={templates.map((t) => ({ fullName: t.fullName, name: t.name }))}
        />
      </main>
    </>
  )
}
