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
- Canvas roster import from a Gradebook CSV export, plus adding students one at a time
- Instructor console for classroom settings and membership management
- Faculty invitations, so only invited colleagues can create classrooms
- Deadlines with per-student and per-team extensions
- Autograding via GitHub Actions
- Feedback pull requests
- Grade export back to Canvas
- Light and dark themes, following the system setting or an explicit choice

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
| Contents | Read & write | Reading templates, writing files |
| **Workflows** | **Read & write** | Writing `.github/workflows/` for autograding |
| Pull requests | Read & write | Feedback pull requests |
| Actions | Read-only | Reading autograding workflow runs and artifacts |
| Metadata | Read-only | Mandatory |

`Workflows` is separate from `Contents` and easy to miss: writing any file under
`.github/workflows/` needs it *in addition* to `Contents`, and GitHub refuses with a
generic 403 whose body says nothing about which permission is missing — the real
requirement appears only in the `x-accepted-github-permissions` response header.
`src/lib/github/errors.ts` detects that header and says so explicitly, because the
first time this happened it cost an afternoon. Note also that adding a permission to
an existing App is **two steps**: save it on the App, then accept the request on the
installation.

**Organization permissions:**

| Permission | Access | Needed for |
|---|---|---|
| Members | **Read & write** | Creating teams, managing team membership, checking membership state |
| Administration | Read-only | Verifying you own the org |

Write access on Members is required because group assignments create teams and add
students to them. Read-only is not enough.

**Subscribe to events:** `Workflow run` and `Push` — those are the only two
`src/app/api/webhooks/github/route.ts` acts on. Anything else is acknowledged and
discarded, so subscribing more widely just adds deliveries that do nothing. (`ping`
arrives whether you subscribe or not, when the webhook is first saved.)

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

## Who can create classrooms

Signing in with GitHub proves only that someone has a GitHub account, and every
student has one. So it cannot be what decides who may create a classroom — before
this gate existed, any student who found `/classrooms/new` could create one and become
its instructor.

Three levels:

| | Can join a classroom | Can create classrooms | Can invite faculty |
|---|---|---|---|
| Anyone signed in | ✅ via a roster invite link | — | — |
| Faculty | ✅ | ✅ | — |
| Site admin | ✅ | ✅ | ✅ |

### The front page, and the two doors

`/` is a public landing page for signed-out visitors and the classroom dashboard for
everyone else. It is written for faculty deciding whether to use this, because they are
the only people who reach it without a link — students arrive on `/join/<token>` and
never see it. The page it replaced was a bare "Sign in" button addressed to nobody,
which read as a wall.

There is no generic sign-in on it. The ways in are specific:

| Who | Where |
|---|---|
| Students | the invite link their instructor sends |
| Faculty | the invitation link an administrator sends |
| Administrators | `/admin/signin`, linked discreetly in the footer |

`/admin/signin` is **framing, not a permission check**. There is one authentication
mechanism — GitHub OAuth — so it is the same button pointed at a different destination.
Anyone may open it and sign in, and will land on an empty dashboard unless
`SITE_ADMIN_LOGINS` names them. It has to be in the proxy's public list, because the
only people it serves are signed out; leaving it behind the cookie wall bounced them to
`/signin` and made it a link to nowhere.

**`/signin` must keep existing.** The proxy sends signed-out visitors there with `next`
set, which is how every classroom invite link works. Removing it would dead-end student
registration.

Motion on the landing page runs through two classes, `uccc-flow` and `uccc-rise`, so
its behaviour is one change rather than many.

**It plays for everyone, including readers whose system requests reduced motion.** That
is a deliberate decision, recorded here because it otherwise reads as an oversight. The
cost is real: `prefers-reduced-motion` is set by people for whom movement triggers
vestibular symptoms or migraine, and a landing page is reached without warning. To
honour the preference again, add this back to `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .uccc-flow { animation: none; }
  .uccc-rise { animation: none; opacity: 1; transform: none; }
}
```

The `opacity: 1` there is not optional. `uccc-rise` begins at `opacity: 0`, so disabling
the animation without restoring opacity leaves the content permanently invisible — worse
than either motion setting, and easy to ship without noticing. There is a test asserting
no element is left transparent under **either** preference, which stays true regardless
of which way the decision goes.

### The `dark:` variant is redefined

`globals.css` overrides Tailwind's `dark:` variant so it matches the design tokens: the
system asks for dark *and* the reader has not overridden to light, or the reader chose
dark explicitly.

Without that override the variant keys off `prefers-color-scheme` alone while the theme
follows `data-theme`, and the two disagree in exactly the cases the toggle exists for. It
showed up as the UCF mark going invisible — white on a forced-light page, black on a
forced-dark one — and only for readers whose system setting opposed their choice, which
is why it survived review on machines that agreed with their owner. Any `dark:` utility
added later would have inherited the same fault.

### One App, many organizations

Each faculty member installs the GitHub App on **their own** organization — a classroom
is bound to an organization and an installation, and the installation token is what
creates repositories there. Adding an App to an organization requires being an owner of
it, so this is not something an administrator can do on someone's behalf.

Their path is: accept a faculty invitation, install the App on their organization
granting access to **all repositories**, then create a classroom and pick it. The
install link is shown on the new-classroom page and derived from the API rather than
configured, because the App slug differs per registration and a hardcoded URL would
point colleagues at the wrong App.

**No Marketplace listing is needed.** Marketplace is for public distribution and wants a
verified publisher, a listing and review. An App set to *Any account* is installable by
anyone with the URL, which is all this needs.

#### The organization picker is filtered by membership

`GET /app/installations` returns **every** installation of the App, App-wide. Offering
that list directly was fine with one user and became a multi-tenancy hole with two: a
faculty member could point a classroom at a colleague's organization, and assignments
would then generate repositories there using an installation token holding
`Administration: write`. The ownership check downstream only *warns*, so it did not stop
this.

So membership is a hard gate, enforced both in the picker and in `createClassroom` —
a filtered dropdown is not a permission check, since a form can be posted directly.
Membership is a much weaker claim than ownership, which is the point: you cannot be a
member of an organization you have nothing to do with. Ownership stays warn-not-block,
because everything except group assignments works for a plain member and blocking would
strand an instructor mid-promotion.

Organizations that have the App but that you do not belong to are **named in a count**
rather than silently dropped — otherwise someone who knows the App is installed
somewhere sees "not installed" and reasonably concludes the page is broken. An
organization whose membership could not be confirmed is excluded and reported too, since
an unverifiable membership is exactly the case the gate exists for.

#### One organization can back many classrooms

It used to back only one. The rule lived in two places — the picker dropped any
organization that already hosted a classroom, and `createClassroom` refused one anyway if
the form was posted — on the stated grounds that two classrooms in one organization would
generate colliding repository names. That was not true: `dedupeRepoName` appends a numeric
suffix after checking the organization's live repository list, so collisions were already
handled before the rule existed. There is no unique index on `githubOrgId` behind it
either; the constraint that actually keeps classrooms distinct is the unique `slug`, which
is derived from course code and term.

What the rule did cost was real. It meant one organization per course, so the spring run
of the same course needed a brand-new organization, a fresh App installation, and a fresh
ownership check — and the symptom was the picker saying every organization you belong to
already has a classroom, with no way forward.

So an organization may back as many classrooms as you like. The picker names how many each
one already holds, and the form suggests giving each assignment a distinct repository
prefix, which is what actually keeps the names readable when a term's `hw1-` sits beside
the last term's.

### The favicon brings its own background

The Pegasus artwork is solid black on transparency. The site header can show it as-is on
a light surface and invert it to white on a dark one, because the page knows which theme
it is in — a favicon does not. A bare mark would be a black shape on the near-black tab
strip of any browser in dark mode, so the icon sits on a UCF-gold plate instead and reads
the same either way.

The mark is inset only 6% of the icon's width, which looks tight at 512px and is the
point: at 16px the Pegasus is at the edge of legibility, and ordinary padding thins its
strokes past one pixel and turns it into a smudge. `scripts/build-icons.mjs` renders each
size from the 192px original rather than downscaling one large composite, so the artwork
is resampled once. Look at a 16px render before changing either number.

### Signing in is open, deliberately

Anyone with a GitHub account can sign in. That is a decision, not an oversight, and it
is the same thing GitHub Classroom does.

Signing in grants nothing. Measured against a signed-in account with no invitation:

| | |
|---|---|
| Dashboard | 200 — empty, with guidance on how to get access |
| `/classrooms/new`, `/admin/faculty` | **403** |
| Any classroom, roster, gradebook, assignment | **404** |

Note the 404 rather than 403: a stranger cannot even confirm a classroom exists. The
only trace of them is one `users` row with no memberships.

It has to work this way, because students sign in *before* they claim a roster entry —
that is the registration flow. Requiring an invitation to sign in at all would mean a
student who signs in before opening the link hits a dead end, which is support load in
week one for no gain, given that a bare account can reach nothing.

**The classroom invite link is the real boundary**, and it is worth knowing what it is
not: anyone signed in who has the URL can open the join page and claim an unclaimed
roster entry. Possessing the link is the check. That is also GitHub Classroom's model,
and it means a forwarded link could let an outsider claim a student's identity and
repository.

Judged acceptable here because the link is shared only inside a course, every claim is
recorded in the audit log, and an instructor can unlink a mis-claimed entry from the
roster page, which frees it to be claimed again. If that trade stops being acceptable —
a larger course, a link that leaked — the fix is per-student claim codes, mail-merged
from the roster, so the link alone is not enough.

**Site admins come from configuration, not the database.** `SITE_ADMIN_LOGINS` is a
comma-separated list of GitHub logins, read on every request:

```
SITE_ADMIN_LOGINS="kpmoran"
```

That solves the bootstrap. A fresh deployment has no users, so nobody could otherwise
grant the first one anything — and the alternative, "the first account to sign in
becomes admin", is a race anyone who finds the URL before you can enter. It also means
revoking an admin is a config change and a restart rather than a database edit, with
no stale row to miss.

**Faculty come from invitations.** A site admin creates one at `/admin/faculty` and
sends the link. It is bounded like the student invite links, because it is a privilege
escalation if it leaks: single-use by default, always expiring, revocable, and every
redemption recorded against the account that used it.

Two decisions worth knowing:

- **Redeeming needs a button press, not just opening the link.** Mail clients, Slack
  unfurls and security proxies all follow URLs, and any of them would otherwise consume
  a single-use invitation before the recipient clicked anything. The landing page is
  read-only; accepting is a POST.
- **Every rejection shows the same message.** Distinguishing "no such invitation" from
  "already used up" would confirm to someone guessing tokens that a particular one is
  real.

Withdrawing someone's faculty access does not touch the classrooms they already run —
they remain an instructor there. Removing someone mid-semester from courses full of
student work is a much larger decision than "should they be able to start new ones".

The migration that adds this grants faculty to everyone already recorded as an
INSTRUCTOR of a classroom, so introducing the gate cannot lock out the people already
teaching here — but note the gap: someone who had signed in and *not yet created a
classroom* is not covered, which includes whoever just deployed it.

### If you have locked yourself out

Symptom: you sign in, and there is no "New classroom" button and no "Faculty access".
It means neither route to faculty applied — `SITE_ADMIN_LOGINS` is not reaching the
container, and you had no classroom for the migration to grandfather.

Check the configuration actually arrived, which is the usual cause. Appending to
`.env` with `>>` when the file has no trailing newline silently joins the new setting
onto the previous line, and both are then lost:

```bash
cd /opt/uccc
tail -3 .env                                              # is the line intact and on its own?
docker compose exec -T app sh -c 'echo "[$SITE_ADMIN_LOGINS]"'   # did it reach the container?
```

To get straight back in, set the flags directly — the column is checked as well as the
configuration:

```bash
docker compose exec -T postgres psql -U uccc -d uccc \
  -c 'update users set "isFaculty" = true, "isSiteAdmin" = true where "githubLogin" = '"'"'your-login'"'"';'
```

Then fix `SITE_ADMIN_LOGINS` properly, because it is what survives a database restore.

## Light and dark

The theme follows the reader's system setting by default, and the control in the header
offers **Auto / Light / Dark**.

Three options rather than a switch, because "follow my system" is a real preference and
not the same as either fixed choice — a binary toggle discards it the first time you
touch the control, with no way back. It is a radio group, so it announces as one control
with three options and arrow keys move between them; a single cycling button would
announce only its current state and give no hint what pressing it does.

Three things that are easy to get wrong here and are each covered by a test:

- **Forcing light on a machine set to dark.** The dark rules are guarded with
  `:root:not([data-theme='light'])`, or the media query keeps winning and the control
  appears broken in exactly one direction — which you will not notice if you test on a
  light machine.
- **`color-scheme` has to track the explicit choice too**, not just the system one, or
  a forced-light page gets dark checkboxes, date pickers and scrollbars.
- **No flash of the wrong theme.** An inline, synchronous script in `<head>` applies
  the saved choice before the first paint. Anything deferred — a client effect, a module
  import — runs after the browser has painted, and the flash is worst for exactly the
  readers a theme control exists to serve.

The control is on the sign-in page as well as in the header: someone who cannot
comfortably read the page needs to fix that before signing in, not after.

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

## Pages do not wait on GitHub to render

The new-assignment form fetched the organization's template repositories while
rendering. That made it about **fifty times** slower to respond than the classroom page
it is reached from — 280ms against 5ms locally, on an organization holding two
repositories. Because "New assignment" is a client-side navigation with no fallback to
show, the browser kept displaying the *previous* page for the whole wait, so the click
looked ignored rather than slow, and the natural response was to click it again.

The suggestions were never load-bearing. The template field accepts any `owner/repo` as
free text and validates it on submit, so the form is completely usable before the list
exists. It is now fetched by the combobox after it mounts, via the
`getTemplateSuggestions` action, which authorizes exactly as the create action does —
the list contains private repository names and must not be readable by anyone who could
not already create the assignment.

Two details worth keeping:

* The list loads **into state**, not through a Suspense boundary. Suspense would replace
  the input with a fresh one when the data landed and take any half-typed value with it —
  the same failure as an uncontrolled field being reset by a form action, but landing
  mid-word. Keeping one mounted instance is what makes `typing survives the suggestions
  arriving` pass.
* There is deliberately **no `loading.tsx`** on these routes, and that is worth knowing
  before adding one. A route-level loading file makes Next flush that shell — with a
  **200** — before the page component runs, so a `forbidden()` inside the page can no
  longer set the status. The body is still correct (a student sees the forbidden page and
  no settings), but the status lies, and anything reading the status rather than the body
  is told the request succeeded. It was measured: with a `loading.tsx`, `/settings` and
  `/assignments/new` returned 200 to a student while `/roster`, which had none, correctly
  returned 403. The skeleton was worth about five milliseconds of cosmetics once the
  blocking calls were gone, so it lost. `a student cannot reach instructor settings` now
  asserts the status on both routes.

`listTemplateRepos` also stopped paginating the whole organization. It asks the search
API for `org:<org> template:true`, which is one request instead of one per hundred
repositories — and a classroom organization gains a repository per student per
assignment, so the old cost grew every time the app was used. Verified against a real
installation: search does return **private** templates to an installation token, which
is the case that matters, since course templates usually are. Search is a separate index
with its own rate limit and can lag repository creation by a few seconds, so the
exhaustive listing remains as a fallback and the field still takes free text.

**Classroom settings** had the same shape and is fixed the same way, except that there the
answer is streamed rather than fetched by the client. The live ownership check decides
which of two badges to show, and used to run before the page replied — delaying the
settings form, the invite panel and the archive controls, none of which depend on it. The
card now renders immediately with the organization name, which the database already knows,
and the badge arrives over the stream: **~16ms to first byte against ~200–270ms**, with
the badge landing about 150ms later.

Note that Suspense is right there and was wrong for the template picker. The deciding
question is whether the subtree holds state a person owns: replacing a badge when the data
lands costs nothing, whereas re-mounting a text field discards what was being typed. Same
mechanism, opposite conclusion.

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
| `npm run build:icons` | Regenerate the favicon and app icons from `public/ucf-pegasus.png` |

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

One Linux host, three containers, deployed by GitHub Actions on every green push
to `main`. Everything under `deploy/` is version-controlled and copied to the
server each deploy, so the running configuration cannot drift from what is
reviewed. Secrets live in `/opt/uccc/.env` **on the server only** and are never
copied, printed, or stored as GitHub secrets.

```
              ┌────────── the host ───────────────────────┐
  :443 ──────▶│ caddy   automatic TLS, HSTS, gzip         │
              │   └──▶ app     Next.js + pg-boss worker   │
              │          └──▶ postgres   no published port│
              └───────────────────────────────────────────┘
```

Caddy is the only container with published ports. Postgres has none at all, so it
is unreachable from the internet even if the host firewall is wrong, and the app
has none either — publishing 3000 would serve it over plain HTTP beside the TLS it
is supposed to be behind.

### 1. Buy the domain

Cloudflare Registrar sells at cost with no upsells, and its DNS has an API. Pick
something short that students can type from a slide — `ucfcodeconnect.com`,
`knightscode.dev`. Then create one record:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `@` (or a subdomain) | your server's public IPv4 | **DNS only** at first |

Leave the proxy **off** for the first deploy. Caddy proves it controls the domain
over plain HTTP on port 80, and Cloudflare's proxy intercepts that. Once a
certificate has been issued you can switch the proxy on, but set SSL/TLS mode to
**Full (strict)** when you do — "Flexible" makes Cloudflare talk to your server
over unencrypted HTTP while showing students a padlock.

### 2. Prepare the server

Needs a public IPv4, inbound 22/80/443, and root. Then, once:

```bash
sudo bash deploy/bootstrap.sh code-connect.example.edu
```

That installs Docker, creates `/opt/uccc`, generates `AUTH_SECRET`,
`ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET` and the Postgres password on the machine
that will use them, creates an unprivileged `uccc-deploy` user with an SSH key for
Actions, and prints the values you need. It is idempotent — re-running will not
overwrite an existing `.env` or key.

Then fill in the four GitHub App values it left blank (`AUTH_GITHUB_ID`,
`AUTH_GITHUB_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`).

**Back up `ENCRYPTION_KEY` somewhere you would trust with a password.** It decrypts
every stored instructor OAuth token. Lose it and every instructor reconnects; leak
it and you have handed over `admin:org` on your organization.

### 2a. Create a Linode Cloud Firewall

Free, and worth doing for one specific reason: **`ufw` does not protect published
container ports.** Docker inserts its rules into the `FORWARD` chain ahead of ufw's,
so `docker run -p 5432:5432` reaches the internet even with `ufw deny 5432` active.
A Cloud Firewall is enforced upstream in Linode's network, before traffic reaches
the host, so nothing the host's iptables does can bypass it.

The compose file here publishes only 80 and 443, on Caddy. The firewall turns that
from a property of the current compose file into a guarantee.

Inbound, default policy **DROP**:

| Protocol | Port | Source | Why |
|---|---|---|---|
| TCP | 22 | anywhere | SSH — see below |
| TCP | 80 | anywhere | ACME challenge, and the HTTP→HTTPS redirect |
| TCP | 443 | anywhere | the app |
| ICMP | — | anywhere | optional, for ping and uptime monitoring |

Outbound: **allow all.** The app must reach `api.github.com`, `ghcr.io` and Let's
Encrypt; restricting outbound breaks certificate issuance for very little gain.

**Do not restrict port 22 to your own address.** It is the instinctive move and it
breaks deploys: GitHub-hosted runners connect from over 7,000 published ranges
(`https://api.github.com/meta`) that change regularly. Keeping a firewall in sync
with that list is worse than leaving 22 open.

Which means key-only authentication is the control that actually matters, so
`bootstrap.sh` disables password authentication — but only when it can find a key
belonging to root or a sudo user first. Absent one it warns and changes nothing,
because disabling passwords on a host whose only access is a password locks you out
and leaves the serial console as the way back in.

### 3. Point the GitHub App at the domain

In the App's settings, three URLs — this is also what finally enables webhooks, so
autograding results and feedback pull requests stop waiting for a sweep:

| Field | Value |
|---|---|
| Homepage URL | `https://your-domain` |
| Callback URL | `https://your-domain/api/auth/callback/github` |
| Webhook URL | `https://your-domain/api/webhooks/github` |
| Webhook secret | the `GITHUB_WEBHOOK_SECRET` from `/opt/uccc/.env` |

Keep `http://localhost:3000/api/auth/callback/github` in the callback list as well
if you still want local sign-in to work — the field accepts several.

### 4. Give Actions the keys

Settings → Secrets and variables → Actions. Four secrets, from the bootstrap
output:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the server's **IP**, not the domain — see below |
| `DEPLOY_USER` | `uccc-deploy` |
| `DEPLOY_SSH_KEY` | the private key printed by bootstrap |
| `DEPLOY_SSH_KNOWN_HOSTS` | the host key printed by bootstrap |

And one **variable** (not a secret): `APP_DOMAIN`, your domain. The deploy uses it
to check the public URL actually answers.

`DEPLOY_HOST` is the IP rather than the domain for two reasons. A `known_hosts`
entry is keyed to the name you connect to, so an entry for the domain does not match
a connection made to the address. And more importantly, a deploy that resolves the
public domain cannot ship a fix when DNS is what is broken.

`DEPLOY_SSH_KNOWN_HOSTS` is required rather than optional. The alternative is
`StrictHostKeyChecking=no`, which would let anything answering on that address
receive a deploy — and the deploy carries a registry token.

### How a deploy runs

`deploy.yml` triggers on `CI` completing successfully on `main`, so a deploy can
only run for a commit that passed typecheck, lint, the unit tests and the build,
and whose image therefore exists. It pins the image to `sha-<commit>` rather than
`latest`, so what is running is always traceable to a commit.

Then: copy `deploy/`, log the server in to GHCR with *this run's* token so no
long-lived registry credential sits on the host, pull, `up -d` (the entrypoint
applies pending migrations), wait for the container healthcheck, then check
`https://your-domain/api/health` from outside. Those last two are separate on
purpose — the first says the app started, the second says DNS, the certificate and
the proxy work, and they fail for entirely different reasons.

**If health never goes green it rolls back** to the image that was running before,
so a bad deploy is a failed workflow rather than an outage.

To roll back by hand, run the Deploy workflow with a `tag` of `sha-<commit>`.

### Operating it

```bash
cd /opt/uccc
docker compose ps                      # what is running
docker compose logs -f app             # application and job worker
docker compose up -d app               # apply an .env change (recreates the container)
docker compose exec postgres psql -U uccc -d uccc
docker compose exec -T postgres pg_dump -U uccc uccc | gzip > ~/uccc-$(date +%F).sql.gz
```

**Applying a change to `/opt/uccc/.env` needs `up -d`, not `restart`.** A container's
environment is fixed when it is created, so `restart` reuses the old values and looks
like the edit did nothing.

The deploy writes `docker-compose.override.yml` next to the compose file, pinning the
exact image it deployed. Compose merges it automatically, so a plain `docker compose
up -d` reuses that image rather than resolving the base file's `:latest` default —
which would otherwise swap a running deployment to a different build, or fail outright
because the host is logged out of the private registry. Delete it and the next deploy
writes it again.

### Backups

The `backup` service takes a verified `pg_dump` nightly at 03:30 UTC (set
`BACKUP_AT`), keeps 14 days (`BACKUP_KEEP_DAYS`), and writes to `/opt/uccc/backups`
on the host — a plain directory rather than a Docker volume, precisely so copying
dumps off the machine is just `scp` against a path you can see.

```bash
cd /opt/uccc
docker compose logs backup                                  # what it has been doing
cat backups/LAST_SUCCESS                                    # when it last worked
docker compose run --rm backup /restore.sh --list           # what is available
```

Restoring — destructive, and it asks before proceeding:

```bash
docker compose run --rm backup /restore.sh                  # newest
docker compose run --rm backup /restore.sh uccc-2026-...dump  # a specific one
docker compose restart app                                  # reconnect cleanly
```

Three deliberate choices, each because the obvious version fails quietly:

- **Every dump is verified before anything is pruned.** `pg_restore --list` must parse
  it, and it must contain at least as many tables as the live database. A job that
  writes unusable files while deleting good ones on a schedule is worse than no
  backups, because it replaces a known gap with false confidence.
- **An empty schema is "nothing to back up", not a failure.** The container starts as
  soon as Postgres is healthy, which on a fresh deploy is before the app has migrated.
  Reporting that as an error would train you to ignore this log.
- **The startup backup is skipped if one exists from the last hour.** `restart:
  unless-stopped` plus a crash loop would otherwise write a dump per restart, and
  retention is by age, so a fast enough loop outruns it.

Verified by restoring, not by reading: rows written, dumped, truncated through 13
cascading tables, restored, and every value checked including booleans — then the app
health-checked green on top of the restored database.

### Getting backups off the box

**The above is only half a backup.** Dumps on `/opt/uccc/backups` protect you from the
common disaster — a bad migration, a mistaken delete, a corrupted table. They do not
survive losing the disk, which is the rarer and worse one.

Simplest fix, from your own machine:

```bash
rsync -avz --delete \
  uccc-deploy@45.79.222.44:/opt/uccc/backups/ ~/uccc-backups/
```

Nightly, in your laptop's crontab:

```
30 8 * * * rsync -az --delete uccc-deploy@<host>:/opt/uccc/backups/ ~/uccc-backups/
```

That depends on the laptop being awake, so for something you would rather not think
about, Linode Object Storage is the proper answer: an S3-compatible bucket the server
pushes to on its own. It needs an access key pair, which is yours to create — say the
word and I will add it to the backup container.

A restore you have never performed is a hope, not a plan. Once real grades are in
there, do a drill: `restore.sh --list`, restore the newest into a scratch database,
and confirm the row counts. Better to find a problem on a Tuesday than in week 14.

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
