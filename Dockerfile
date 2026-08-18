# syntax=docker/dockerfile:1
# The ENV values in the build stages are placeholders that exist only to satisfy
# src/lib/env.ts, which validates at import time. Nothing real is baked in; the
# runtime values arrive from the environment. See the comments at each stage.
# check=skip=SecretsUsedInArgOrEnv

# UCF-Code-Connect runtime image.
#
# One container serves the app *and* runs the pg-boss worker, because
# src/instrumentation.ts starts the worker in-process. That is the whole reason
# this deploys as a single unit; set RUN_WORKER=false if you ever split them.
#
# Debian slim rather than Alpine: Prisma 7 compiles queries with a WASM module
# instead of a native engine, so musl is not the problem it used to be, but `pg`
# and sharp-adjacent native builds are still better behaved against glibc.

ARG NODE_VERSION=22-bookworm-slim

# --- deps ------------------------------------------------------------------
# Dev dependencies included: the build needs typescript, tailwind, and the prisma
# CLI. None of this reaches the final image.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# `postinstall` runs `prisma generate`, which reads DATABASE_URL through
# prisma.config.ts. It never connects — but the variable has to parse as a URL or
# the install fails, hence the placeholder.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
RUN npm ci

# --- migrator --------------------------------------------------------------
# The Prisma CLI, installed on its own so it arrives with its whole dependency
# graph. Copying node_modules/prisma out of the build tree is not enough: it
# require()s @prisma/config, which require()s `effect`, and `output: 'standalone'`
# traces only what the *server* imports. The first attempt at this image built
# fine and then died at startup on `Cannot find module 'effect'`.
#
# Pinned to the same range as the application so the CLI and the client cannot
# drift apart.
FROM node:${NODE_VERSION} AS migrator
COPY package.json /tmp/app-package.json
WORKDIR /migrator
RUN npm init -y > /dev/null \
 && npm install --ignore-scripts --no-audit --no-fund \
      "prisma@$(node -p "require('/tmp/app-package.json').devDependencies.prisma")" \
      "dotenv@$(node -p "require('/tmp/app-package.json').devDependencies.dotenv")"

# --- builder ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Placeholders again. Every route is server-rendered on demand, so the build
# touches neither the database nor GitHub — but src/lib/env.ts validates at import
# time and ENCRYPTION_KEY is length-checked, so these must be present and
# well-formed. ENCRYPTION_KEY here is 32 zero bytes and is never used to encrypt
# anything: the real one arrives at runtime.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public \
    APP_URL=http://localhost:3000 \
    AUTH_SECRET=build-placeholder \
    ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# `output: 'standalone'` traces only the node_modules the server actually reaches,
# so there is no install step here and no package.json to drift.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma 7 compiles queries in WebAssembly. Next's tracer follows JavaScript
# imports, so the .wasm alongside the generated client can be left behind — and it
# is only missed on the first query, at runtime, in production. Copied explicitly
# and verified below rather than trusted.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma/client ./node_modules/.prisma/client

# The migration toolchain, kept in its own directory with its own node_modules.
# Deliberately not merged into the standalone tree: the CLI resolves its
# dependencies and its TypeScript config relative to its working directory, and
# giving it a directory where everything it needs is a sibling is far less fragile
# than grafting packages onto a traced tree. The entrypoint runs it from there.
COPY --from=migrator --chown=nextjs:nodejs /migrator/node_modules ./migrator/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./migrator/prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./migrator/prisma.config.ts

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Fail the build, not a production request, if the WASM module did not make it.
RUN test -f ./node_modules/.prisma/client/query_compiler_fast_bg.wasm \
 || (echo 'Prisma WASM query compiler missing from the image' && exit 1)

USER nextjs
EXPOSE 3000

# No curl or wget in slim, and adding one to health-check is not worth the surface.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
