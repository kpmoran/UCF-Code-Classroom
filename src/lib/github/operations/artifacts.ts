import 'server-only'

import AdmZip from 'adm-zip'

import { getInstallationOctokit, githubRead } from '../app'
import { GitHubDomainError, toDomainError } from '../errors'

/**
 * Reading autograding results out of Actions artifacts.
 *
 * The app *pulls* results rather than having student repositories push them to a
 * callback URL. That means no per-repository secrets, nothing to rotate, and
 * grading still works if the app was offline when the workflow finished — a
 * missed webhook is recoverable by re-scanning workflow runs.
 */

export const RESULTS_ARTIFACT_NAME = 'uccc-autograding-results'
export const RESULTS_FILE_NAME = 'results.json'

/** Artifacts are capped to guard against a workflow uploading something huge. */
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

export type WorkflowRunSummary = {
  id: bigint
  headSha: string
  status: string | null
  conclusion: string | null
  createdAt: string
  updatedAt: string
  htmlUrl: string
}

/** Recent workflow runs for a repo, used by the manual "re-sync grades" action. */
export async function listWorkflowRuns(
  installationId: bigint,
  owner: string,
  repo: string,
  limit = 50,
): Promise<WorkflowRunSummary[]> {
  const data = await githubRead(
    `list workflow runs for repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.rest.actions
        .listWorkflowRunsForRepo({ owner, repo, per_page: Math.min(limit, 100) })
        .then((r) => r.data),
  )

  return data.workflow_runs.map((run) => ({
    id: BigInt(run.id),
    headSha: run.head_sha,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
  }))
}

/**
 * Download and extract `results.json` from a run's artifacts.
 *
 * Returns null (rather than throwing) whenever the artifact is simply absent —
 * a workflow that failed before the upload step, or a repository whose template
 * has no autograding at all, is an expected state and must not fail the job.
 */
export async function fetchAutogradeResults(
  installationId: bigint,
  owner: string,
  repo: string,
  runId: bigint,
): Promise<{ raw: string; artifactId: bigint } | null> {
  const artifacts = await githubRead(
    `list artifacts for workflow run in repo ${owner}/${repo}`,
    installationId,
    (octokit) =>
      octokit.rest.actions
        .listWorkflowRunArtifacts({ owner, repo, run_id: Number(runId), per_page: 100 })
        .then((r) => r.data),
  )

  const artifact = artifacts.artifacts.find((a) => a.name === RESULTS_ARTIFACT_NAME)
  if (!artifact) return null

  if (artifact.expired) {
    throw new GitHubDomainError({
      kind: 'Unknown',
      message: `artifact ${artifact.id} for ${owner}/${repo} has expired`,
      userMessage:
        'The autograding results for this run have expired on GitHub (artifacts are kept ' +
        '90 days by default). Ask the student to push again to regenerate them.',
    })
  }

  if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
    throw new GitHubDomainError({
      kind: 'Unknown',
      message: `artifact ${artifact.id} is ${artifact.size_in_bytes} bytes`,
      userMessage:
        'The autograding results artifact is unexpectedly large and was not downloaded. ' +
        'Check that the grading workflow uploads only results.json.',
    })
  }

  // downloadArtifact returns a 302 to a signed URL; Octokit follows it and
  // hands back the zip bytes.
  let zipBuffer: Buffer
  try {
    const octokit = getInstallationOctokit(installationId)
    const response = await octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: 'zip',
    })
    zipBuffer = Buffer.from(response.data as ArrayBuffer)
  } catch (error) {
    throw toDomainError(error, `download artifact for repo ${owner}/${repo}`)
  }

  const entry = safeReadZipEntry(zipBuffer, RESULTS_FILE_NAME)
  if (entry === null) return null

  return { raw: entry, artifactId: BigInt(artifact.id) }
}

/**
 * Extract one named file from a zip.
 *
 * Entry names are matched by basename and traversal segments are rejected: the
 * archive comes from a student-controlled workflow, so a crafted entry like
 * `../../etc/passwd` must never influence what we read.
 */
function safeReadZipEntry(zipBuffer: Buffer, fileName: string): string | null {
  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuffer)
  } catch (error) {
    throw new GitHubDomainError({
      kind: 'Unknown',
      message: `could not open results artifact as a zip: ${String(error)}`,
      userMessage:
        'The autograding results artifact was not a readable zip file. Check the grading ' +
        'workflow’s upload step.',
      cause: error,
    })
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (name.includes('..') || name.startsWith('/')) continue
    if (name !== fileName && !name.endsWith(`/${fileName}`)) continue

    if (entry.header.size > MAX_ARTIFACT_BYTES) return null
    return entry.getData().toString('utf8')
  }

  return null
}
