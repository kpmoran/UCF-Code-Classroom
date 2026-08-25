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
export function describeBoardFailure(message: string): string {
  const permissionDenied =
    /permission to create projects/i.test(message) || /resource not accessible/i.test(message)

  return permissionDenied
    ? 'The GitHub App is not allowed to create project boards. Add the “Projects: write” ' +
        'permission to the App, then accept it on this organization — a permission change ' +
        'does not take effect until the installation accepts it.'
    : `The project board could not be created: ${message}`
}
