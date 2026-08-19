import Link from 'next/link'

import { NewClassroomForm } from '@/components/new-classroom-form'
import { SiteHeader } from '@/components/site-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireFaculty } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { GitHubDomainError } from '@/lib/github/errors'
import {
  getAppPublicUrl,
  listInstallationsForUser,
  type InstallationSummary,
} from '@/lib/github/operations/orgs'

export default async function NewClassroomPage() {
  const user = await requireFaculty()

  let installations: InstallationSummary[] = []
  let foreign = 0
  let unverifiable = 0
  let loadError: string | null = null

  try {
    // Only organizations this person belongs to. The installation list is App-wide,
    // so without filtering it would offer every colleague's organization.
    const mine = await listInstallationsForUser(user.githubLogin)
    installations = mine.belongs
    foreign = mine.foreign
    unverifiable = mine.unverifiable
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

  // Derived from the API, not configured: the slug differs per App registration, and a
  // hardcoded link would point colleagues at the wrong App.
  const appUrl = await getAppPublicUrl()

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
                  ? 'The app is not installed on any organization you belong to.'
                  : 'Every organization you belong to already has a classroom.'}
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
                {installations.length === 0
                  ? 'Install it on the organization for your course, granting access to all repositories — it needs to create repositories that do not exist yet.'
                  : 'To use a different organization, install the app there too, granting access to all repositories.'}
              </p>

              {appUrl ? (
                <p>
                  <a
                    href={`${appUrl}/installations/new`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline font-medium"
                  >
                    Install the app on an organization →
                  </a>
                </p>
              ) : null}

              {/*
               * Named explicitly, because otherwise someone who knows the app is
               * installed somewhere sees "not installed" and reasonably concludes the
               * page is broken. It is not: those organizations are simply not theirs.
               */}
              {foreign > 0 ? (
                <p className="text-xs text-muted">
                  {foreign} other {foreign === 1 ? 'organization has' : 'organizations have'}{' '}
                  the app installed, but you are not a member, so {foreign === 1 ? 'it is' : 'they are'}{' '}
                  not offered here.
                </p>
              ) : null}

              {unverifiable > 0 ? (
                <p className="text-xs text-warning">
                  {unverifiable}{' '}
                  {unverifiable === 1 ? 'organization was' : 'organizations were'} skipped
                  because your membership could not be confirmed just now. Reload to retry.
                </p>
              ) : null}

              {appUrl ? (
                <p className="text-xs text-muted">
                  App page:{' '}
                  <a href={appUrl} target="_blank" rel="noreferrer" className="underline">
                    {appUrl.replace('https://', '')}
                  </a>
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <>
            <NewClassroomForm
              installations={available.map((i) => ({
                installationId: i.installationId.toString(),
                orgLogin: i.orgLogin,
                repositorySelection: i.repositorySelection,
              }))}
            />

            {/*
             * Shown even when the list is not empty. The organization someone wants is
             * often simply one the app has not been installed on yet, and without this
             * the only signal is an absence — a dropdown that does not contain what they
             * are looking for, with nothing explaining why or what to do.
             */}
            <p className="mt-4 text-xs text-muted">
              Only organizations you are a member of appear here.
              {appUrl ? (
                <>
                  {' '}
                  Want to use a different one?{' '}
                  <a
                    href={`${appUrl}/installations/new`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Install the app on that organization
                  </a>{' '}
                  as well, granting access to all repositories.
                </>
              ) : null}
              {foreign > 0
                ? ` ${foreign} further ${foreign === 1 ? 'organization has' : 'organizations have'} the app installed but you are not a member of ${foreign === 1 ? 'it' : 'them'}.`
                : ''}
            </p>
          </>
        )}
      </main>
    </>
  )
}
