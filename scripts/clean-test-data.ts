import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * Remove accounts and classrooms left behind by the test suites.
 *
 *   npm run db:clean-tests
 *
 * The specs clean up their own classrooms and GitHub resources, but each seeded
 * sign-in creates a `User` row that outlives the run — deliberately, since
 * deleting a user mid-suite would cascade into rows another test still needs.
 * They accumulate as harmless noise in the development database; this clears
 * them out.
 *
 * Identified by their reserved email domains, never by anything a real account
 * could match, and refuses to run against production.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error('clean-test-data must never run in production.')
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

/** Domains used only by test fixtures. */
const TEST_EMAIL_SUFFIXES = ['@e2e.invalid', '@integration.invalid', '@dev.invalid']

/** Classroom slug prefixes used only by test fixtures. */
const TEST_SLUG_PREFIXES = ['e2e', 'jobtest-', 'teamtest-']

async function main() {
  const classrooms = await db.classroom.findMany({
    where: { OR: TEST_SLUG_PREFIXES.map((prefix) => ({ slug: { startsWith: prefix } })) },
    select: { id: true, slug: true },
  })

  if (classrooms.length > 0) {
    console.log(`Deleting ${classrooms.length} test classroom(s):`)
    for (const c of classrooms) console.log(`  ${c.slug}`)
    await db.classroom.deleteMany({ where: { id: { in: classrooms.map((c) => c.id) } } })
  }

  const users = await db.user.findMany({
    where: { OR: TEST_EMAIL_SUFFIXES.map((suffix) => ({ email: { endsWith: suffix } })) },
    select: { id: true, githubLogin: true, email: true },
  })

  if (users.length > 0) {
    console.log(`\nDeleting ${users.length} test user(s):`)
    for (const u of users) console.log(`  ${u.githubLogin ?? '(no login)'} <${u.email}>`)
    // Sessions, accounts and memberships cascade from the user.
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
  }

  const budgets = await db.githubRateBudget.deleteMany({})
  if (budgets.count > 0) console.log(`\nReset ${budgets.count} rate-budget row(s).`)

  if (classrooms.length === 0 && users.length === 0) {
    console.log('Nothing to clean.')
  } else {
    console.log('\nDone.')
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
