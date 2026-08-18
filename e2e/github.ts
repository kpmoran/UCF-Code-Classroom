import 'dotenv/config'

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

/**
 * Direct GitHub access for end-to-end tests.
 *
 * Deliberately does *not* reuse `src/lib/github/**`: those modules import
 * `server-only`, which is resolved by the Next.js bundler and does not exist as
 * an installed package, so importing them from Playwright's plain Node context
 * fails outright.
 *
 * Keeping the test helper separate also means these assertions verify the app's
 * effects on GitHub independently, rather than through the same code that
 * produced them.
 */

export const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'

function octokit(): Octokit {
  const appId = process.env.GITHUB_APP_ID
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY
  const installationId = process.env.VERIFY_INSTALLATION_ID

  if (!appId || !rawKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set for e2e tests')
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey: rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey,
      ...(installationId ? { installationId: Number(installationId) } : {}),
    },
    userAgent: 'ucf-code-connect-e2e',
  })
}

let cachedInstallationId: number | null = null

async function installationClient(): Promise<Octokit> {
  if (process.env.VERIFY_INSTALLATION_ID) return octokit()

  if (cachedInstallationId === null) {
    const app = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID!,
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      },
    })
    const { data } = await app.rest.apps.listInstallations({ per_page: 100 })
    const match = data.find(
      (i) =>
        i.account && 'login' in i.account && i.account.login?.toLowerCase() === ORG.toLowerCase(),
    )
    if (!match) throw new Error(`App is not installed on ${ORG}`)
    cachedInstallationId = match.id
  }

  process.env.VERIFY_INSTALLATION_ID = String(cachedInstallationId)
  return octokit()
}

export async function repoExists(name: string): Promise<boolean> {
  const client = await installationClient()
  try {
    await client.rest.repos.get({ owner: ORG, repo: name })
    return true
  } catch {
    return false
  }
}

export async function getRepoInfo(
  name: string,
): Promise<{ private: boolean; defaultBranch: string } | null> {
  const client = await installationClient()
  try {
    const { data } = await client.rest.repos.get({ owner: ORG, repo: name })
    return { private: data.private, defaultBranch: data.default_branch }
  } catch {
    return null
  }
}

export async function deleteRepoIfExists(name: string): Promise<void> {
  const client = await installationClient()
  try {
    await client.rest.repos.delete({ owner: ORG, repo: name })
  } catch {
    // Already gone.
  }
}

export async function deleteTeamIfExists(teamSlug: string): Promise<void> {
  const client = await installationClient()
  try {
    await client.rest.teams.deleteInOrg({ org: ORG, team_slug: teamSlug })
  } catch {
    // Already gone.
  }
}

export async function teamHasRepoAccess(
  teamSlug: string,
  repo: string,
): Promise<boolean> {
  const client = await installationClient()
  try {
    const { data } = await client.rest.teams.checkPermissionsForRepoInOrg({
      org: ORG,
      team_slug: teamSlug,
      owner: ORG,
      repo,
      // Without this media type the endpoint answers 204 with an empty body.
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    })
    return data.permissions?.push === true
  } catch {
    return false
  }
}

export async function isRepoCollaborator(name: string, username: string): Promise<boolean> {
  const client = await installationClient()
  try {
    await client.rest.repos.checkCollaborator({ owner: ORG, repo: name, username })
    return true
  } catch {
    return false
  }
}
