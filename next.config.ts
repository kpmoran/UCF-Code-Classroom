import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    // Enables `forbidden()` / `unauthorized()` from next/navigation, used by
    // the data access layer in src/lib/auth/dal.ts to distinguish "you may not
    // do this" (403) from "no such thing" (404). Still experimental in 16.3.
    authInterrupts: true,
  },
  // Prisma's query engine and pg are native/server-only; keep the bundler from
  // trying to trace them into any client or edge output.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg', 'pg-boss'],
  // Emit .next/standalone: a self-contained server plus only the node_modules it
  // actually reaches. This is what the Dockerfile ships, and it is why the runtime
  // image needs no npm install and no package.json.
  output: 'standalone',
}

export default nextConfig
