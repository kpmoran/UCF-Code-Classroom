# GitHub App setup

One GitHub App registration is all that is required.

## Credentials

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

## 1. Create the GitHub organization

Create an organization for the course (e.g. `ucf-cop4331-fall-2026`). You must be
an **owner**, not just an admin. GitHub offers free Team plans for education via
[GitHub Education](https://education.github.com/).

Set the organization's **base repository permission** to **No permission** (Settings →
Member privileges). Classrooms make students members of the organization, and any base
permission above that would let every student read every other student's private
repository. The app checks this before switching the feature on and before each
invitation, and refuses while it is wrong.

## 2. Register a GitHub App

Go to **Organization Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Homepage URL**: `http://localhost:3000` (your deployed URL in production)
- **Callback URL**: `http://localhost:3000/api/auth/callback/github`
- **Callback URL** (add a second): `http://localhost:3000/api/auth/callback/github-owner`
  — the "Connect GitHub as organization owner" button in classroom settings signs in
  through a separate Auth.js provider, so it has its own callback path. Omit it and that
  button fails with GitHub's `redirect_uri is not associated with this application`,
  which names nothing useful.
- **Request user authorization (OAuth) during installation**: checked
- **Webhook URL**: see [Webhooks in development](../development/webhooks.md)
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

## 3. Collect credentials into `.env`

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

## 4. Install the App on the organization

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

## 5. Optional: connect as org owner

Group assignments work without this. It only registers a fallback credential, for
the case where GitHub refuses a team operation to the App token. Sign in, then use
**Connect GitHub as org owner** in classroom settings; the token is stored
encrypted under `ENCRYPTION_KEY`.

> Students are never asked for elevated access. Student sign-in requests only
> `read:user` and `user:email`.
