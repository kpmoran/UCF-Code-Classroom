# Commands and project layout

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
    students/              Organization membership for students: rules and actions
    canvas/                Roster CSV import, grade CSV export
    autograding/           Workflow rendering, results parsing
  jobs/                    pg-boss queue and handlers
  app/                     Routes
  test/                    Vitest setup and stubs
```
