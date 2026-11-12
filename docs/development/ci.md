# Continuous integration

Two workflows, split by whether they need credentials.

## `ci.yml` — every push and pull request

Typecheck, lint, the 298 unit tests, and a production build. No secrets, no
database: verified by running the whole job against an unroutable `DATABASE_URL`.
That means it also works on pull requests from forks, where GitHub withholds
secrets by design.

The placeholder `ENCRYPTION_KEY` in that workflow is 32 zero bytes rather than an
arbitrary string, because `src/lib/env.ts` length-checks it at import time and the
job would otherwise fail before running anything.

A second job builds the container image, so a broken `Dockerfile` is caught on the
pull request that broke it. It only *publishes* from `main`, and only after
`check` has passed — see [Deploying](../deployment/deploying.md).

## `verify.yml` — main, nightly, or on request

The Playwright and integration suites, against the real sandbox organization.
Run from the Actions tab with **Run workflow** any time.

These are not on every push, for three reasons worth knowing before you change it:

- They need App credentials, which fork pull requests cannot see.
- Both raise the rate budget to 40 content-creating calls per minute. GitHub's
  secondary limit is 80 per minute per installation, so two runs at once sit
  exactly on the ceiling — which is why `integration` waits for `e2e` via `needs:`
  instead of running beside it, and why the workflow takes a repository-wide
  `concurrency` lock that is **not** cancel-in-progress. A cancelled run leaves
  repositories behind in the sandbox org, because the cleanup steps only happen if
  the job reaches them.
- They use fixed repository and team names in one shared organization, so
  concurrent runs would collide on the resources themselves.

## What the organization-membership suite does and does not touch

`src/jobs/studentOrgAccess.integration.test.ts` covers the jobs behind "Students in the
organization" — the invitation gate, the student team, reconciliation, end-of-term
removal, and the group-assignment resend. It is written around two facts about the
sandbox that are worth knowing before you change either:

- **It never invites anyone to the organization, and never removes anyone from it.**
  `VERIFY_USER` is a member every other suite depends on, so the removal job is run
  only on its refusal paths, each of which must leave that account exactly as it was.
  The one real pending invitation it creates is addressed to an email with no account
  behind it, and is cancelled again by the same test (and by cleanup, if the test dies).
- **It does not change the sandbox's base repository permission.** The invite job
  refuses on anything above "No permission", and the sandbox is set to "read", so the
  refusal path runs against GitHub's real answer and the happy path is reached by
  stubbing that single read — after a separate test has proved the real read works.
  A production organization has to have that setting at "No permission" before the
  feature does anything; the classroom settings page shows the check live.

## Keeping the test emails out of your inbox

The GitHub-touching suites need a real account to stand in for a student: they invite it
as a repository collaborator and add it to teams, and GitHub refuses to do either for a
name that does not exist. The consequence is that whoever that account is gets an email
each time a run creates and tears those down — and since `verify.yml` runs on every push
to `main` as well as nightly, a busy day means a busy inbox.

Set the **`VERIFY_USER`** repository variable to a machine account that belongs to
`VERIFY_ORG`, and the notifications go there instead of to a person:

```bash
gh variable set VERIFY_USER --repo <owner>/<repo> --body uccc-test-bot
```

It defaults to `kpmoran`, so leaving it unset keeps the current behaviour. The same
variable is read by `npm run test:github` and the Playwright suites locally, which is
worth knowing: **running the suites on your own machine sends those emails too**, so this
is not only a CI setting.

Two things the bot account needs, and nothing else: membership of the organization, so
team and collaborator operations resolve, and no special permissions. The one test that
does need an owner — the ownership check in `connectivity.integration.test.ts` — reads
`VERIFY_OWNER` instead, which defaults to `kpmoran` and only needs setting if the sandbox
changes hands.

## Secrets to add

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `SANDBOX_APP_ID` | The App's numeric ID |
| `SANDBOX_APP_PRIVATE_KEY` | The whole `.pem`, pasted as-is — multi-line is fine |

Secret names cannot begin with `GITHUB_`; the workflow maps these onto
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` itself.

`AUTH_SECRET`, `ENCRYPTION_KEY`, and `GITHUB_WEBHOOK_SECRET` are **generated fresh
each run** rather than stored. Nothing survives between runs that would need the
same key, and no test posts a webhook, so the webhook secret only has to be
non-empty to satisfy `requireGitHubAppConfig()`.

No instructor OAuth token is needed. Team operations try the App token first and
only fall back to an owner token on an auth failure, and the App token is
sufficient in this organization — so the suites never exercise the fallback.

Optionally, as repository **variables** rather than secrets: `VERIFY_ORG` and
`VERIFY_INSTALLATION_ID`, to point the suites at a different sandbox. Note that
the installation ID is *also* hardcoded in the seeded classrooms inside each
`e2e/*.spec.ts`, so repointing means editing those too — if you ever reinstall the
App, that is the first thing to fix, and a green `ci.yml` with a red `verify.yml`
is the symptom.
