import 'server-only'

import { putFile } from '@/lib/github/operations/contents'

import {
  MANIFEST_PATH,
  renderWorkflow,
  WORKFLOW_PATH,
  type GradingTestSpec,
} from './renderWorkflow'

/**
 * Write the autograding workflow and its manifest into a repository.
 *
 * Called at provisioning and again whenever an assignment's tests change. `putFile`
 * skips the write when the content already matches, so re-running does not litter a
 * student's history with empty "update workflow" commits — which matters because
 * that history is what the feedback pull request shows.
 *
 * Returns what changed so the caller can log it, and never throws for a missing
 * repository: a student's repository may be deleted between the sweep and the
 * write.
 */
export async function injectAutogradingWorkflow(opts: {
  installationId: bigint
  owner: string
  repo: string
  tests: readonly GradingTestSpec[]
}): Promise<{ workflowChanged: boolean; manifestChanged: boolean }> {
  const { workflowYaml, manifestJson } = renderWorkflow(opts.tests)

  // The manifest is written first. If only one of the two writes lands, a stale
  // workflow reading a fresh manifest degrades to "unknown test, skipped", whereas
  // a fresh workflow reading a missing manifest fails the collect step outright.
  const manifest = await putFile(
    opts.installationId,
    opts.owner,
    opts.repo,
    MANIFEST_PATH,
    manifestJson,
    'Update autograding test manifest',
  )

  const workflow = await putFile(
    opts.installationId,
    opts.owner,
    opts.repo,
    WORKFLOW_PATH,
    workflowYaml,
    'Update autograding workflow',
  )

  return {
    workflowChanged: workflow.changed,
    manifestChanged: manifest.changed,
  }
}
