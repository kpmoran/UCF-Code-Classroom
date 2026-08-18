import { describe, expect, it } from 'vitest'

import { getInstallationOctokit } from './app'
import { checkOrgOwnership, listAppInstallations } from './operations/orgs'

/**
 * Step 1 of GitHub verification: can we authenticate as the App at all, and is
 * the instructor genuinely an organization owner?
 *
 * Everything downstream is meaningless if these fail, and each failure mode here
 * has a distinct, actionable cause (wrong App ID, malformed private key, App not
 * installed, instructor is only an admin).
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const INSTRUCTOR = process.env.VERIFY_USER ?? 'kpmoran'

let installationId: bigint

describe('GitHub App connectivity', () => {
  it('authenticates as the App and lists its installations', async () => {
    const installations = await listAppInstallations()

    console.log(
      `\n  Installations visible to the App:\n` +
        installations
          .map(
            (i) =>
              `    ${i.orgLogin} (installation ${i.installationId}, repos: ${i.repositorySelection})`,
          )
          .join('\n'),
    )

    expect(installations.length).toBeGreaterThan(0)
  })

  it(`finds the installation on ${ORG}`, async () => {
    const installations = await listAppInstallations()
    const match = installations.find(
      (i) => i.orgLogin.toLowerCase() === ORG.toLowerCase(),
    )

    expect(
      match,
      `The App is not installed on ${ORG}. Install it from the App settings page.`,
    ).toBeDefined()
    if (!match) return

    installationId = match.installationId

    // A "selected repositories" install cannot create new repos, which is the
    // whole point of the app — catch it here rather than at provisioning time.
    expect(
      match.repositorySelection,
      'The App must be installed with access to ALL repositories, because it creates ' +
        'repositories that do not exist yet.',
    ).toBe('all')
  })

  it('mints a working installation token', async () => {
    const installations = await listAppInstallations()
    const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
    if (!match) return

    // Exercises the private key end to end: a malformed key fails here.
    const octokit = getInstallationOctokit(match.installationId)
    const { data } = await octokit.rest.orgs.get({ org: ORG })

    console.log(`\n  Org: ${data.login} (id ${data.id}), plan: ${data.plan?.name ?? 'n/a'}`)
    expect(data.login.toLowerCase()).toBe(ORG.toLowerCase())
  })

  it(`confirms ${INSTRUCTOR} is an owner of ${ORG}`, async () => {
    const installations = await listAppInstallations()
    const match = installations.find((i) => i.orgLogin.toLowerCase() === ORG.toLowerCase())
    if (!match) return

    const result = await checkOrgOwnership(match.installationId, ORG, INSTRUCTOR)
    console.log(`\n  Ownership check: ${JSON.stringify(result)}`)

    expect(
      result.isOwner,
      `Not an owner: ${'reason' in result ? result.reason : ''}`,
    ).toBe(true)
  })
})

export { installationId }
