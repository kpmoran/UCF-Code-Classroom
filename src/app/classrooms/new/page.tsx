import Link from 'next/link'

import { NewClassroomForm } from '@/components/new-classroom-form'
import { SiteHeader } from '@/components/site-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireFaculty } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import { listAppInstallations, type InstallationSummary } from '@/lib/github/operations/orgs'

export default async function NewClassroomPage() {
  await requireFaculty()

  let installations: InstallationSummary[] = []
  let loadError: string | null = null

  try {
    installations = await listAppInstallations()
  } catch (error) {
    loadError =
      error instanceof GitHubDomainError
        ? error.userMessage
        : error instanceof Error
          ? error.message
          : 'Could not reach GitHub.'
  }

  // An org already backing a classroom is not offered again: two classrooms in
  // one org would generate colliding repository names.
  const used = await db.classroom.findMany({ select: { githubOrgId: true, name: true } })
  const usedOrgIds = new Map(used.map((c) => [c.githubOrgId.toString(), c.name]))

  const available = installations.filter(
    (i) => !usedOrgIds.has(i.orgId.toString()),
  )

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-2xl px-6 py-8">
        <div className="mb-6">
          <Link href="/" className="text-sm text-muted hover:underline">
            ← Classrooms
          </Link>
          <h1 className="text-2xl font-semibold mt-2">New classroom</h1>
          <p className="text-sm text-muted mt-1">
            A classroom is backed by a GitHub organization. Assignment repositories are
            created inside it.
          </p>
        </div>

        {loadError ? (
          <Card>
            <CardHeader>
              <CardTitle>Cannot reach GitHub</CardTitle>
              <CardDescription>{loadError}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted space-y-2">
              <p>
                Check that <code className="font-mono">GITHUB_APP_ID</code> and{' '}
                <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code> are set in{' '}
                <code className="font-mono">.env</code>, then restart the server.
              </p>
              <p>See “GitHub App setup” in the README.</p>
            </CardContent>
          </Card>
        ) : available.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No GitHub organization available</CardTitle>
              <CardDescription>
                {installations.length === 0
                  ? 'The UCF-Code-Connect app is not installed on any organization yet.'
                  : 'Every organization the app is installed on already has a classroom.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm space-y-3">
              {installations.length > 0 ? (
                <ul className="space-y-1 text-muted">
                  {installations.map((i) => (
                    <li key={i.installationId.toString()} className="font-mono text-xs">
                      {i.orgLogin} → “{usedOrgIds.get(i.orgId.toString())}”
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted">
                Install the app on the organization for this course, granting access to{' '}
                <strong>all repositories</strong> — it needs to create repositories that do
                not exist yet.
              </p>
              <p>
                <a
                  href="https://github.com/settings/installations"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline font-medium"
                >
                  Manage GitHub app installations →
                </a>
              </p>
            </CardContent>
          </Card>
        ) : (
          <NewClassroomForm
            installations={available.map((i) => ({
              installationId: i.installationId.toString(),
              orgLogin: i.orgLogin,
              repositorySelection: i.repositorySelection,
            }))}
          />
        )}
      </main>
    </>
  )
}
