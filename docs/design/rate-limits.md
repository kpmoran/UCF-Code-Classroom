# Rate limits

GitHub enforces a secondary limit of **80 content-creating requests per minute
and 500 per hour**. Generating a repository plus inviting a collaborator is two
calls per student, so bulk-provisioning a 200-student assignment consumes roughly
400 of the hourly budget.

That secondary limit is easy to miss, because the number most people find is the
*primary* one — 5,000 requests per hour for an installation, documented on a
different page. Both apply, and it is the per-minute one that bulk provisioning
runs into first.

Consequently all GitHub mutations run through a persistent job queue behind a
shared token bucket (`GITHUB_CONTENT_CALLS_PER_MINUTE` / `_PER_HOUR`, defaulting
to 60 and 400). Those are *our* numbers, kept under GitHub's, because the same
allowance covers anything staff do in the web UI at the same time — so the gap
between 60 and 80 is thinner in practice than it looks. **Do not raise them past
GitHub's own 80 and 500** — jobs would start failing with 403s instead of waiting
their turn. Provisioning a large class legitimately takes
several minutes; the UI shows an ETA.

Setting them too *low* has its own failure mode, and it is less obvious. The
per-minute value was originally 6. Provisioning a single repository spends most
of that, so the project-board job queued behind it was refused — by us, not by
GitHub — and a twelve-student backfill filled the assignment page with rate-limit
notices. When a job is refused this way the error is marked retryable and must be
rethrown so pg-boss reschedules it; swallowing it strands the work with a message
promising it will continue automatically. `src/jobs/createProjectBoard.ts` has the
one line that matters, and `createProjectBoard.test.ts` pins it.
