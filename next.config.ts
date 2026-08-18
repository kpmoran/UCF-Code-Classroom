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
}

export default nextConfig
