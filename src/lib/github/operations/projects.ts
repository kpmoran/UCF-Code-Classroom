import 'server-only'

import { githubMutate, githubRead } from '../app'

/**
 * Project boards, for assignments that want one per student or per team.
 *
 * Three GitHub facts shape everything here, and each one is a dead end if you only
 * know the previous one:
 *
 *   1. Repository-level boards were retired on 23 August 2024, and the classic REST
 *      API followed on 1 April 2025 — which is why those endpoints answer 404 rather
 *      than 403. Boards are now owned by an account.
 *   2. Linking is ownership-bound: "You can only list projects that are owned by the
 *      same user or organization that owns the repository." Assignment repositories
 *      belong to the classroom's organization, so a board that attaches to one must
 *      be owned by that organization — a student's own board never can.
 *   3. There is no REST API for any of it. Projects v2 is GraphQL only.
 *
 * `createProjectV2` accepts `repositoryId`, so creating and linking is a single
 * mutation rather than two round trips — worth having when this runs once per student.
 */

export type ProjectBoard = { url: string; number: number; title: string }

/** GraphQL node ids, which the v2 API works in rather than REST ids. */
async function organizationNodeId(installationId: bigint, org: string): Promise<string> {
  const data = await githubRead(`node id for org ${org}`, installationId, (octokit) =>
    octokit.graphql<{ organization: { id: string } | null }>(
      `query($login: String!) { organization(login: $login) { id } }`,
      { login: org },
    ),
  )

  if (!data.organization) {
    throw new Error(`GitHub returned no organization named ${org}.`)
  }
  return data.organization.id
}

/**
 * Create a board owned by `org` and link it to `repoNodeId`.
 *
 * Goes through `githubMutate` rather than `githubRead`: this creates something, and
 * it competes for the same 80-per-minute secondary limit as generating repositories.
 * A provisioning run for a large class would otherwise quietly double its own budget.
 */
export async function createLinkedProjectBoard(input: {
  installationId: bigint
  org: string
  repoNodeId: string
  title: string
}): Promise<ProjectBoard> {
  const { installationId, org, repoNodeId, title } = input
  const ownerId = await organizationNodeId(installationId, org)

  const data = await githubMutate(
    `create project board "${title}" in ${org}`,
    installationId,
    (octokit) =>
      octokit.graphql<{
        createProjectV2: { projectV2: { url: string; number: number; title: string } }
      }>(
        `mutation($ownerId: ID!, $title: String!, $repositoryId: ID!) {
           createProjectV2(input: {
             ownerId: $ownerId,
             title: $title,
             repositoryId: $repositoryId
           }) {
             projectV2 { url number title }
           }
         }`,
        { ownerId, title, repositoryId: repoNodeId },
      ),
  )

  return data.createProjectV2.projectV2
}

/**
 * The repository's GraphQL node id, which `createProjectV2` needs for linking.
 *
 * Kept separate from the REST `RepoSummary` deliberately: that type is used all over
 * the provisioning path and does not otherwise need a second identifier for the same
 * repository.
 */
export async function repositoryNodeId(
  installationId: bigint,
  org: string,
  repo: string,
): Promise<string> {
  const data = await githubRead(`node id for repo ${org}/${repo}`, installationId, (octokit) =>
    octokit.graphql<{ repository: { id: string } | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      { owner: org, name: repo },
    ),
  )

  if (!data.repository) {
    throw new Error(`GitHub returned no repository named ${org}/${repo}.`)
  }
  return data.repository.id
}

/**
 * Turn a board-creation failure into something an instructor can act on.
 *
 * The permission case is the one that matters, because it is the default state: the
 * App does not request `Projects: write`, so every classroom hits this until someone
 * adds the permission *and* accepts it on the organization. GitHub phrases it as
 *
 *   "ucf-code-connect[bot] does not have permission to create projects on ownerId O_…"
 *
 * which names a node id and no remedy. Matched case-insensitively and on the phrase
 * rather than the exact sentence: an earlier version looked for "Resource not
 * accessible" and a capitalised "Projects", and matched neither, so the actionable
 * message never appeared. The unit test pins the real wording.
 */
export function describeBoardFailure(
  message: string,
  stage: 'create' | 'share' = 'create',
): string {
  const permissionDenied =
    /permission to create projects/i.test(message) || /resource not accessible/i.test(message)

  if (permissionDenied) {
    return (
      'The GitHub App is not allowed to create project boards. Add the “Projects: write” ' +
      'permission to the App, then accept it on this organization — a permission change ' +
      'does not take effect until the installation accepts it.'
    )
  }

  // Naming the step matters. Every failure this has produced so far said "could not be
  // created" about boards that had been created seconds earlier and only failed to be
  // shared — which sends you looking for a board that is already there.
  return stage === 'share'
    ? `The project board was created but could not be shared: ${message}`
    : `The project board could not be created: ${message}`
}

/** The project's node id, from the number we stored when it was created. */
export async function projectNodeIdByNumber(
  installationId: bigint,
  org: string,
  number: number,
): Promise<string | null> {
  const data = await githubRead(`project ${org}#${number}`, installationId, (octokit) =>
    octokit.graphql<{ organization: { projectV2: { id: string } | null } | null }>(
      `query($login: String!, $number: Int!) {
         organization(login: $login) { projectV2(number: $number) { id } }
       }`,
      { login: org, number },
    ),
  )
  return data.organization?.projectV2?.id ?? null
}

/**
 * GraphQL node ids for a set of logins, in one round trip.
 *
 * Aliased rather than queried one at a time because this runs per board, and the
 * instructors repeat across every board in the assignment. Unknown logins come back
 * absent rather than throwing: a student who has since deleted their GitHub account
 * should not stop everyone else's board being shared.
 */
export async function userNodeIds(
  installationId: bigint,
  logins: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(logins)].filter(Boolean)
  if (unique.length === 0) return new Map()

  const fields = unique
    .map((_, i) => `u${i}: user(login: $l${i}) { id login }`)
    .join('\n')
  const params = unique.map((_, i) => `$l${i}: String!`).join(', ')
  const variables = Object.fromEntries(unique.map((login, i) => [`l${i}`, login]))

  const data = await githubRead(`node ids for ${unique.length} user(s)`, installationId, (octokit) =>
    octokit.graphql<Record<string, { id: string; login: string } | null>>(
      `query(${params}) { ${fields} }`,
      variables,
    ),
  )

  const out = new Map<string, string>()
  for (const value of Object.values(data ?? {})) {
    if (value?.id && value.login) out.set(value.login.toLowerCase(), value.id)
  }
  return out
}

export type BoardCollaborator = { userId: string; role: 'READER' | 'WRITER' | 'ADMIN' }

/**
 * Give people access to a board.
 *
 * Without this a board is created and nobody can open it. A Projects v2 board owned
 * by an organization is private, and one created through an installation token has
 * the App as its only collaborator — so every human, including the organization's
 * owners, gets a 404. GitHub returns 404 rather than 403 for things you cannot see,
 * which makes it look like the board was never created at all.
 *
 * Idempotent: setting the same roles again is a no-op, which is what lets this double
 * as the repair path for boards created before access was granted.
 */
export async function setProjectCollaborators(
  installationId: bigint,
  projectId: string,
  collaborators: readonly BoardCollaborator[],
): Promise<void> {
  if (collaborators.length === 0) return

  await githubMutate(`share project ${projectId}`, installationId, (octokit) =>
    octokit.graphql(
      `mutation($projectId: ID!, $collaborators: [ProjectV2Collaborator!]!) {
         updateProjectV2Collaborators(input: {
           projectId: $projectId,
           collaborators: $collaborators
         }) { clientMutationId }
       }`,
      { projectId, collaborators },
    ),
  )
}
