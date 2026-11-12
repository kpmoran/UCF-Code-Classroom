# Quick start

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
that touches GitHub will fail with a clear message until you complete the
[GitHub App setup](github-app.md).
