# A stale worker will happily run last week’s code

The job worker starts once per process, from `src/instrumentation.ts`, and pg-boss claims
work from tables in the shared Postgres. Two consequences that have both cost real
debugging time:

* **Editing a job handler and reloading the page changes nothing.** Next's hot reload does
  not re-run `instrumentation.ts`, so the worker keeps the handler it registered at boot.
  Restart the dev server.
* **Any orphaned `next` process still claims jobs.** It does not need to be serving
  traffic, or holding a port — a process whose HTTP listener has gone but which is still
  alive will keep taking jobs off the queue and running whatever code it started with. One
  five days old made a fixed repository-naming bug look unfixed: the E2E suite kept
  producing the old names while the unit and integration suites, which run the handler
  in-process, passed.

`lsof -iTCP:3000` does not find these, which is exactly what made it confusing. Look for
the processes themselves:

```bash
ps -eo pid,lstart,command | grep -E 'next-server|next dev' | grep -v grep
```

If a start time predates the change you are testing, that process is the one answering.
