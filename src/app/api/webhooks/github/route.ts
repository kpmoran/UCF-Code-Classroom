import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { enqueue, QUEUES } from '@/jobs/queue'
import { verifyGitHubSignature } from '@/lib/webhooks/verify'

/**
 * GitHub webhook receiver.
 *
 * Does as little as possible: verify the signature, translate the event into a
 * job, and return. Real work happens on the worker, because GitHub expects a
 * response within ten seconds and will retry — and retries of a handler that does
 * the work inline mean duplicate processing.
 *
 * **Every request is authenticated by HMAC before anything else is read.** The
 * endpoint is public by necessity, so without that check anyone could post a
 * `workflow_run` payload and have us award marks.
 */

export const runtime = 'nodejs'

type WorkflowRunPayload = {
  action?: string
  workflow_run?: {
    id?: number
    name?: string
    head_sha?: string
    status?: string
    conclusion?: string | null
    html_url?: string
    run_attempt?: number
  }
  repository?: { id?: number; full_name?: string; name?: string }
  installation?: { id?: number }
}

type PushPayload = {
  repository?: { id?: number; full_name?: string }
  head_commit?: { timestamp?: string } | null
  after?: string
}

export async function POST(request: Request): Promise<Response> {
  // Read the raw body: the signature covers the exact bytes GitHub sent, so
  // parsing first and re-serialising would not reproduce them.
  const body = await request.text()

  // Verification lives in lib/webhooks/verify.ts so it can be unit tested against
  // forged, replayed and malformed signatures.
  const verified = verifyGitHubSignature(
    body,
    request.headers.get('x-hub-signature-256'),
    env.GITHUB_WEBHOOK_SECRET,
  )
  if (!verified.ok) {
    // Logged with the reason, but the response stays terse: a detailed body would
    // help someone probe the endpoint.
    console.warn(`[webhook] rejected delivery: ${verified.reason}`)
    return Response.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = request.headers.get('x-github-event')
  const deliveryId = request.headers.get('x-github-delivery') ?? 'unknown'

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    switch (event) {
      case 'workflow_run':
        return await handleWorkflowRun(payload as WorkflowRunPayload)
      case 'push':
        return await handlePush(payload as PushPayload)
      case 'ping':
        return Response.json({ ok: true, pong: true })
      default:
        // Subscribed-but-unhandled events are acknowledged, not errored: a 4xx
        // would make GitHub mark the delivery as failed and retry it forever.
        return Response.json({ ok: true, ignored: event })
    }
  } catch (error) {
    console.error(`[webhook] ${event} delivery ${deliveryId} failed:`, error)
    // A 500 tells GitHub to retry, which is what we want for a transient fault.
    return Response.json({ error: 'Processing failed' }, { status: 500 })
  }
}

async function handleWorkflowRun(payload: WorkflowRunPayload): Promise<Response> {
  const run = payload.workflow_run
  const repositoryId = payload.repository?.id

  if (!run?.id || !repositoryId) {
    return Response.json({ ok: true, ignored: 'incomplete payload' })
  }

  // Only completed runs carry results worth downloading.
  if (payload.action !== 'completed') {
    return Response.json({ ok: true, ignored: `action=${payload.action}` })
  }

  // Match on the GitHub repository id rather than its name, so a renamed
  // repository still resolves.
  const repo = await db.assignmentRepo.findFirst({
    where: { githubRepoId: BigInt(repositoryId) },
    select: { id: true, assignment: { select: { autogradeEnabled: true } } },
  })

  if (!repo) {
    // A repository in the org that this app did not create, or one already
    // deleted. Nothing to do.
    return Response.json({ ok: true, ignored: 'unknown repository' })
  }

  if (!repo.assignment.autogradeEnabled) {
    return Response.json({ ok: true, ignored: 'autograding disabled' })
  }

  await enqueue(
    QUEUES.ingestAutogradeRun,
    { githubRepoId: String(repositoryId), workflowRunId: String(run.id) },
    // Keyed by run so GitHub's own delivery retries collapse into one job.
    { singletonKey: `autograde:${run.id}` },
  )

  return Response.json({ ok: true, queued: true })
}

/**
 * Record the time of the latest push.
 *
 * Cheap, and it makes the assignment overview meaningful without polling GitHub
 * for every repository on every page load.
 */
async function handlePush(payload: PushPayload): Promise<Response> {
  const repositoryId = payload.repository?.id
  if (!repositoryId) return Response.json({ ok: true, ignored: 'no repository' })

  const pushedAt = payload.head_commit?.timestamp
    ? new Date(payload.head_commit.timestamp)
    : new Date()

  const updated = await db.assignmentRepo.updateMany({
    where: { githubRepoId: BigInt(repositoryId) },
    data: { lastPushedAt: Number.isNaN(pushedAt.getTime()) ? new Date() : pushedAt },
  })

  /**
   * A push is the moment a feedback pull request becomes openable — before it,
   * GitHub refuses one for having no commits between base and head. Queue it now so
   * the instructor sees the PR promptly rather than at the next sweep.
   */
  const awaitingPr = await db.assignmentRepo.findMany({
    where: {
      githubRepoId: BigInt(repositoryId),
      feedbackPrNumber: null,
      assignment: { feedbackPrEnabled: true },
    },
    select: { id: true },
  })

  for (const repo of awaitingPr) {
    await enqueue(
      QUEUES.ensureFeedbackPr,
      { assignmentRepoId: repo.id },
      { singletonKey: `feedback-pr:${repo.id}` },
    )
  }

  return Response.json({ ok: true, updated: updated.count, feedbackPrQueued: awaitingPr.length })
}
