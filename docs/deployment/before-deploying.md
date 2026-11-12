# Before deploying

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
