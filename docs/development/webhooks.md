# Webhooks in development

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
