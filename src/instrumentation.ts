/**
 * Server startup hook.
 *
 * Runs once per server instance, before requests are served. Used to start the
 * pg-boss worker in the same process as the app, which keeps a single-VM
 * deployment to one container.
 *
 * On a serverless host the worker cannot live here — the process is torn down
 * between requests — so `RUN_WORKER=false` disables it and the worker runs as a
 * separate long-lived container instead.
 */
export async function register() {
  // Guard on runtime: `register` is called for edge too, where pg and pg-boss
  // cannot load.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.RUN_WORKER === 'false') {
    console.log('[jobs] RUN_WORKER=false — worker not started in this process')
    return
  }

  try {
    const { startWorker } = await import('./jobs/worker')
    await startWorker()
  } catch (error) {
    // A failed worker must not stop the app from serving pages: instructors can
    // still manage classrooms, and the failure is visible in the provisioning UI
    // as jobs that never leave "queued".
    console.error('[jobs] failed to start worker:', error)
  }
}
