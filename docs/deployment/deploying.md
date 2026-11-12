# Deploying

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

## 1. Buy the domain

Cloudflare Registrar sells at cost with no upsells, and its DNS has an API. Pick
something short that students can type from a slide — `code-classroom.com`,
`knightscode.dev`. Then create one record:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `@` (or a subdomain) | your server's public IPv4 | **DNS only** at first |

If you are **renaming** an existing deployment rather than starting one, also set
`LEGACY_DOMAIN` in `/opt/uccc/.env` to the old hostname. Caddy then serves both names
and permanently redirects the old one, path intact, so invite links already pasted into
a syllabus keep working. That matters more than it sounds: the app builds new links from
`APP_URL`, but it cannot reach back and rewrite the ones students already have. Letting
the old name lapse instead is not a clean retirement either — the `Strict-Transport-Security`
header is sticky for a year, so a browser that has already visited will refuse plain HTTP
on that name and show a connection error rather than following a redirect. On a fresh
install `bootstrap.sh` sets `LEGACY_DOMAIN` equal to `APP_DOMAIN`, which the Caddyfile
treats as "none".

Leave the proxy **off** for the first deploy. Caddy proves it controls the domain
over plain HTTP on port 80, and Cloudflare's proxy intercepts that. Once a
certificate has been issued you can switch the proxy on, but set SSL/TLS mode to
**Full (strict)** when you do — "Flexible" makes Cloudflare talk to your server
over unencrypted HTTP while showing students a padlock.

## 2. Prepare the server

Needs a public IPv4, inbound 22/80/443, and root. Then, once:

```bash
sudo bash deploy/bootstrap.sh code-classroom.example.edu
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

## 2a. Create a Linode Cloud Firewall

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

## 3. Point the GitHub App at the domain

In the App's settings, three URLs — this is also what finally enables webhooks, so
autograding results and feedback pull requests stop waiting for a sweep:

| Field | Value |
|---|---|
| Homepage URL | `https://your-domain` |
| Callback URL | `https://your-domain/api/auth/callback/github` |
| Callback URL | `https://your-domain/api/auth/callback/github-owner` |
| Webhook URL | `https://your-domain/api/webhooks/github` |
| Webhook secret | the `GITHUB_WEBHOOK_SECRET` from `/opt/uccc/.env` |

Both are needed: the second is the organization-owner connection, and a missing entry
there shows up only as a `redirect_uri` error at the moment someone clicks the button.
The field holds as many as you like — `/api/auth/providers` on a running instance lists
exactly what the app will ask GitHub for, which is the quickest way to check.

Keep `http://localhost:3000/api/auth/callback/github` in the callback list as well
if you still want local sign-in to work — the field accepts several.

## 4. Give Actions the keys

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

## How a deploy runs

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

### The image name is derived, not written down

`deploy.yml` computes `ghcr.io/<github.repository>`, lowercased, at run time. It used
to be a literal, and **renaming the repository broke the deploy**: `ci.yml` publishes to
`ghcr.io/${{ github.repository }}` through `docker/metadata-action`, so it followed the
new name immediately while the deploy kept pulling the old one and died at the pull with
`failed to resolve reference`. Deriving both from the same source is what stops the
publisher and the consumer drifting apart. The lowercasing is still needed either way —
Docker references must be lowercase and `github.repository` preserves the repository's
real casing.

If the repository is renamed again, note that GHCR does **not** follow it: the old
package keeps the old images, and CI starts a new package under the new name. The
running container is unaffected until the next deploy.

### A rollback rewrites the override file

`docker-compose.override.yml` on the host pins the full image reference, and compose
merges it over anything the environment says. The rollback used to set `IMAGE_TAG` and
run `up -d`, which the override quietly ignored — so it re-pulled the tag that had just
failed and reported success at having changed nothing. It now writes the previous
reference into the override, which also covers the case where the *name* changed rather
than just the tag.
