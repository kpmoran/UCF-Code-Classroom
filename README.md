# UCF-Code-Connect

[![CI](https://github.com/kpmoran/UCF-Code-Connect/actions/workflows/ci.yml/badge.svg)](https://github.com/kpmoran/UCF-Code-Connect/actions/workflows/ci.yml)

A self-hosted GitHub Classroom replacement for UCF courses.

The app is an **orchestration layer over a real GitHub organization**. It owns the
course-shaped concepts GitHub has no notion of — classrooms, rosters, assignments,
teams, deadlines, grades — and drives the GitHub REST API to materialize them as
repositories, teams, and collaborator invitations. Students work in real GitHub
repos, with real Actions and real pull requests.

## Features

- Classrooms per course, backed by a GitHub organization
- Student self-registration via an invite link and roster self-identification
- Assignments generated from template repositories
- Individual **and** group (team) assignments
- Canvas roster import from a Gradebook CSV export
- Instructor console for classroom settings and membership management
- Deadlines with per-student and per-team extensions
- Autograding via GitHub Actions
- Feedback pull requests
- Grade export back to Canvas

## Stack

Next.js 16 (App Router) · TypeScript · Postgres 16 · Prisma 7 · Auth.js v5 ·
Octokit · pg-boss · Tailwind 4 · Vitest · Playwright

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Generate the three secrets and paste them in:
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY  (must be exactly 32 bytes)
openssl rand -hex 32      # GITHUB_WEBHOOK_SECRET

# 3. Start Postgres (Docker Desktop must be running)
npm run db:up

# 4. Apply migrations and load development data
npm run db:deploy
npm run db:seed

# 5. Run
npm run dev
```

The app boots without GitHub credentials so you can work on the UI, but anything
that touches GitHub will fail with a clear message until you complete the setup
below.

## GitHub App setup

One GitHub App registration is all that is required.

### Credentials

| Credential | Used for | Required? |
|---|---|---|
| **App installation token** | Everything — creating repos from templates, collaborator invitations, writing files, opening PRs, reading Actions results, creating teams, managing team membership | Yes |
| **Instructor user token** | Team operations only, as an automatic fallback | No |

The installation token is the primary credential for all operations, including
teams. Verified against a live organization: with `Organization members: write`
it creates teams and manages membership, and a membership call for a nonexistent
user returns **404, not 403** — meaning authorization succeeded and only the
account lookup failed.

The nuance is worth recording, because GitHub's own documentation is ambiguous
here. GitHub states that inviting a user who is not yet an organization member
requires an org **owner**, and the 404 above is strong but indirect evidence that
an installation token satisfies that. So
`src/lib/github/operations/teams.ts` tries the App token first and falls back to
the instructor's user token if — and only if — GitHub refuses on authorization
grounds. Group assignments need no extra setup, and the fallback is there if
GitHub's behavior differs from what was measured.

Note also that **GitHub App user tokens do not use OAuth scopes at all.** Such a
token's power is the intersection of the App's installed permissions and the
user's own, and its reported scope is always an empty string. That is why the
instructor fallback works by virtue of being an org owner rather than by
requesting `admin:org`, and why a single App registration suffices.

### 1. Create the GitHub organization

Create an organization for the course (e.g. `ucf-cop4331-fall-2026`). You must be
an **owner**, not just an admin. GitHub offers free Team plans for education via
[GitHub Education](https://education.github.com/).

### 2. Register a GitHub App

Go to **Organization Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Homepage URL**: `http://localhost:3000` (your deployed URL in production)
- **Callback URL**: `http://localhost:3000/api/auth/callback/github`
- **Request user authorization (OAuth) during installation**: checked
- **Webhook URL**: see [Webhooks in development](#webhooks-in-development)
- **Webhook secret**: the `openssl rand -hex 32` value you generated

**Repository permissions:**

| Permission | Access | Needed for |
|---|---|---|
| Administration | Read & write | Creating repositories in the org |
| Contents | Read & write | Reading templates, injecting the autograding workflow |
| Pull requests | Read & write | Feedback pull requests |
| Actions | Read-only | Reading autograding workflow runs and artifacts |
| Metadata | Read-only | Mandatory |

**Organization permissions:**

| Permission | Access | Needed for |
|---|---|---|
| Members | **Read & write** | Creating teams, managing team membership, checking membership state |
| Administration | Read-only | Verifying you own the org |

Write access on Members is required because group assignments create teams and add
students to them. Read-only is not enough.

**Subscribe to events:** `Workflow run`, `Push`, `Repository`, `Member`, `Organization`

### 3. Collect credentials into `.env`

| `.env` key | Where to find it |
|---|---|
| `GITHUB_APP_ID` | App settings page, "App ID" |
| `AUTH_GITHUB_ID` | App settings page, "Client ID" |
| `AUTH_GITHUB_SECRET` | App settings page → "Generate a new client secret" |
| `GITHUB_APP_PRIVATE_KEY` | App settings page → "Generate a private key", downloads a `.pem` |
| `GITHUB_WEBHOOK_SECRET` | The value you set in step 2 |

The private key must be a single environment-variable line. Convert the `.pem`:

```bash
awk 'BEGIN{ORS="\\n"} {print}' your-app.private-key.pem
```

Both a PEM with literal `\n` escapes and a plain base64 blob are accepted.

### 4. Install the App on the organization

From the App settings page, **Install App** → pick your course org → **All
repositories** (it needs to create new ones).

Verify the install with:

```bash
npm run test:github
```

That authenticates as the App, confirms the installation and its granted
permissions, checks that you are an org **owner** (not merely an admin), then
exercises real template generation, idempotent re-runs, collaborator invitations,
team creation, and feedback pull requests against the org.

> **Adding a permission to an existing App?** GitHub does not apply it
> retroactively. The organization owner must accept the change on the
> installation page (Settings → GitHub Apps → Configure) before it takes effect.

### 5. Optional: connect as org owner

Group assignments work without this. It only registers a fallback credential, for
the case where GitHub refuses a team operation to the App token. Sign in, then use
**Connect GitHub as org owner** in classroom settings; the token is stored
encrypted under `ENCRYPTION_KEY`.

> Students are never asked for elevated access. Student sign-in requests only
> `read:user` and `user:email`.

## Exporting grades to Canvas

From a classroom, open **Grades → Download CSV**, then in Canvas go to
**Grades → Import** and upload it.

Canvas matches rows on the identity columns it emitted — `Student`, `ID`,
`SIS User ID`, `SIS Login ID`, `Section` — so the export reproduces them
**verbatim from the file you imported**. That is why roster import keeps every
source column in `rawColumns`: reconstructing those fields from normalized values
works until a name contains something that got normalized away, at which point
Canvas silently creates a second row instead of matching.

Two behaviours worth knowing before you import:

- **A blank cell means "no change".** Students with no score — never submitted, or
  never linked a GitHub account — export blank rather than as `0`, because a zero
  actively records a failing grade.
- **The "Points Possible" row is off by default.** Leave it off unless you want the
  import to overwrite each assignment's point value in Canvas.

A manual override always beats the autograded score. Click any cell in the
gradebook to set one; clear the field to fall back to autograding.

## Webhooks in development

GitHub cannot reach `localhost`. Note that `gh webhook forward` handles
**repository and organization** webhooks only — it cannot forward a GitHub App's
webhook. Two options:

**Option A — organization webhook via the GitHub CLI (no third-party service).**
An org webhook covers every repository in the course org, which is exactly the
scope we need:

```bash
gh extension install cli/gh-webhook
# One-time: the CLI token needs permission to manage org webhooks.
gh auth refresh -h github.com -s admin:org_hook

gh webhook forward --org=<your-org> --events=workflow_run,push \
  --url=http://localhost:3000/api/webhooks/github \
  --secret="$GITHUB_WEBHOOK_SECRET"
```

**Option B — smee.io, the conventional GitHub App path.** Create a channel at
<https://smee.io>, set it as the App's Webhook URL, then:

```bash
npx smee-client --url https://smee.io/<channel> \
  --target http://localhost:3000/api/webhooks/github
```

This routes payloads through a third-party relay; fine for development, not for
production.

In production, set the App's Webhook URL to
`https://<your-host>/api/webhooks/github` directly and neither option is needed.

Missed deliveries are always recoverable — use **Re-sync grades** on an
assignment, which walks recent workflow runs directly instead of waiting for a
webhook.

## Rate limits

GitHub enforces a secondary limit of **80 content-creating requests per minute
and 500 per hour**. Generating a repository plus inviting a collaborator is two
calls per student, so bulk-provisioning a 200-student assignment consumes roughly
400 of the hourly budget.

Consequently all GitHub mutations run through a persistent job queue behind a
shared token bucket (`GITHUB_CONTENT_CALLS_PER_MINUTE` / `_PER_HOUR`).
Provisioning a large class legitimately takes tens of minutes; the UI shows an
ETA. **Do not raise these limits to speed it up** — jobs will start failing with
403s instead.

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest) — fast, no network |
| `npm run test:github` | Integration tests against the real GitHub org (creates and deletes repos) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run db:up` / `db:down` | Start / stop Postgres |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply existing migrations |
| `npm run db:reset` | Drop, re-migrate, re-seed |
| `npm run db:seed` | Load development data |
| `npm run db:clean-tests` | Remove accounts and classrooms left by the test suites |
| `npm run db:studio` | Prisma Studio |

## Project layout

```
prisma/
  schema.prisma            Data model
  migrations/              Includes hand-written CHECK constraints
  seed.ts                  Development data (no GitHub calls)
src/
  lib/
    env.ts                 Validated environment; fails loudly on misconfig
    db.ts                  Prisma client singleton (pg driver adapter)
    crypto.ts              AES-256-GCM for tokens at rest
    github/                App/owner auth, rate limiter, typed errors
    canvas/                Roster CSV import, grade CSV export
    autograding/           Workflow rendering, results parsing
  jobs/                    pg-boss queue and handlers
  app/                     Routes
  test/                    Vitest setup and stubs
```

## Continuous integration

Two workflows, split by whether they need credentials.

### `ci.yml` — every push and pull request

Typecheck, lint, the 298 unit tests, and a production build. No secrets, no
database: verified by running the whole job against an unroutable `DATABASE_URL`.
That means it also works on pull requests from forks, where GitHub withholds
secrets by design.

The placeholder `ENCRYPTION_KEY` in that workflow is 32 zero bytes rather than an
arbitrary string, because `src/lib/env.ts` length-checks it at import time and the
job would otherwise fail before running anything.

A second job builds the container image, so a broken `Dockerfile` is caught on the
pull request that broke it. It only *publishes* from `main`, and only after
`check` has passed — see [Deploying](#deploying).

### `verify.yml` — main, nightly, or on request

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

### Secrets to add

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

## Before deploying

Three things in this repository are development conveniences that must not reach
a server students can reach.

**`scripts/dev-session.ts` is an authentication bypass.** It forges a signed
Auth.js session for any GitHub login, with `--admin` for site admin, without a
password or an OAuth round trip. That is exactly what makes local development and
the E2E suite workable, and exactly what makes it catastrophic in production —
anyone who can run it becomes any instructor. It refuses to run when
`NODE_ENV=production`, but treat that as a seatbelt, not a lock: the guard only
fires if the environment variable is set correctly, and it does nothing about a
copy of the script sitting on a box where someone can set `NODE_ENV` themselves.
`scripts/` is in `.dockerignore`, so it is not in the image at all — which is the
actual lock. Keep it that way.

**Rotate `GITHUB_CLIENT_SECRET` and the App private key.** The current values were
pasted into a terminal session during setup, so they should be considered
disclosed. Regenerate both from the App's settings page before the App is used
for a real course.

**Set a fresh `AUTH_SECRET` and `ENCRYPTION_KEY` per environment.** The
development values are in `.env`, which is gitignored but still shared with this
machine. `ENCRYPTION_KEY` in particular decrypts every stored instructor OAuth
token — losing it means reconnecting every instructor, and leaking it means
handing over `admin:org` on your GitHub organization.

## Deploying

Every push to `main` publishes a container image to
`ghcr.io/kpmoran/ucf-code-connect:latest`, built by the `image` job in `ci.yml`
only after typecheck, lint, unit tests, and the build have passed. Also tagged by
commit sha, so a rollback is a tag change rather than a rebuild.

```bash
docker run -d --name uccc -p 3000:3000 --env-file .env.production \
  ghcr.io/kpmoran/ucf-code-connect:latest
```

One container serves the app *and* runs the pg-boss worker, because
`src/instrumentation.ts` starts the worker in-process. That is deliberate: a
single-VM course deployment stays one unit. If you ever split them, set
`RUN_WORKER=false` on the web containers and run one worker separately —
provisioning, deadline enforcement, and autograde ingestion all live there, so
without it repositories never leave "queued".

The entrypoint applies pending migrations before serving. Safe for one container;
set `RUN_MIGRATIONS=false` and migrate as a separate step if you ever run more
than one replica, because concurrent `migrate deploy` against one database makes
the losers fail startup rather than wait.

**Put a reverse proxy in front and terminate TLS there.** Auth.js is configured
with `trustHost: true`, which it has to be for any self-hosted deployment — it
builds callback URLs from the `Host` header. That header is only as trustworthy as
what sets it, so the proxy should set `Host` rather than pass an arbitrary one
through.

Two things the image does not do, by design: it has no `.env`, so every value
comes from the environment; and it contains no `scripts/`, no tests, and no `e2e/`
(which carries the sandbox organization and installation ids).

### Verifying a change to the image

The Dockerfile is easy to get subtly wrong in ways that only appear at runtime, so
build and boot it against a scratch database rather than trusting a green build:

```bash
docker build -t uccc:local .
docker exec uccc-postgres createdb -U uccc uccc_dockertest
docker run --rm -p 3001:3000 \
  -e DATABASE_URL='postgresql://uccc:uccc_dev_password@host.docker.internal:5433/uccc_dockertest?schema=public' \
  -e APP_URL='http://localhost:3001' \
  -e AUTH_SECRET=x -e ENCRYPTION_KEY="$(head -c 32 /dev/zero | base64)" \
  uccc:local
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/auth/session   # must be 200
```

That last check is not arbitrary. It is the endpoint that returned 500 with
`UntrustedHost` — breaking every sign-in — on the first working build of this
image, and neither the 298 unit tests nor the 50 end-to-end tests could see it,
because Auth.js only enforces host trust when `NODE_ENV=production`.

## Notes on Prisma 7

Prisma 7 removed `url` from the `datasource` block. The connection string now
lives in `prisma.config.ts` for CLI commands, and reaches the runtime client
through the `@prisma/adapter-pg` driver adapter in `src/lib/db.ts`. Two
constraints that Prisma cannot express — "an assignment repo belongs to exactly
one of a student or a team", and the same for extensions — are enforced by
hand-written SQL in `prisma/migrations/*_exclusive_owner_checks/`.

## Notes on Next.js 16

`middleware.ts` is now `proxy.ts` and runs on the Node.js runtime. Per the
Next.js authentication guide, proxy is used only for optimistic redirects;
real authorization happens in the data access layer (`requireClassroomRole`),
which every server action and page calls.
