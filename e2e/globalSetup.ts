import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * Clear the persisted GitHub rate budget before an end-to-end run.
 *
 * The budget lives in Postgres so it survives restarts, which means a previous
 * run that drained it leaves the next one starting empty and backing off from the
 * first job. Resetting keeps runs independent.
 */
export default async function globalSetup() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  try {
    const { count } = await db.githubRateBudget.deleteMany({})
    if (count > 0) console.log(`[e2e] reset ${count} rate-budget row(s)`)
  } catch (error) {
    console.warn(`[e2e] could not reset rate budget: ${String(error)}`)
  } finally {
    await db.$disconnect()
  }
}
