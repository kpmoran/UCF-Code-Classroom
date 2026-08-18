import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { env } from './env'

/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter rather than a datasource URL in the schema,
 * so the connection string is supplied here. The global cache keeps `next dev`
 * hot reloads from opening a new connection pool on every edit, which otherwise
 * exhausts Postgres' connection limit within a few minutes of editing.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
