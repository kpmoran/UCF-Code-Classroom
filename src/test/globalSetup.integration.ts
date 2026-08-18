import { config } from 'dotenv'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

config({ path: '.env', quiet: true })

/**
 * Clear the persisted GitHub rate budget before an integration run.
 *
 * The budget lives in Postgres precisely so it survives process restarts — which
 * means a suite that drains the bucket leaves the *next* run starting empty and
 * failing immediately. Resetting here keeps runs independent.
 *
 * This only ever deletes rows in the local development database.
 */
export async function setup() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  try {
    const { count } = await db.githubRateBudget.deleteMany({})
    if (count > 0) console.log(`[integration] reset ${count} rate-budget row(s)`)
  } catch (error) {
    // A missing table just means migrations have not run; the suite will say so.
    console.warn(`[integration] could not reset rate budget: ${String(error)}`)
  } finally {
    await db.$disconnect()
  }
}
