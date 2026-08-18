import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'node:crypto'

/**
 * Create a signed-in session for local development and tests, printing the
 * cookie to use.
 *
 *   npx tsx scripts/dev-session.ts <github-login> [--admin]
 *
 * This exists because GitHub OAuth needs a real browser, which makes automated
 * verification of authenticated pages impossible otherwise. Auth.js database
 * sessions are just rows, so one can be inserted directly.
 *
 * Refuses to run against NODE_ENV=production — it would be an authentication
 * bypass there.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error('dev-session must never run in production.')
}

const login = process.argv[2]
if (!login) {
  console.error('Usage: npx tsx scripts/dev-session.ts <github-login> [--admin]')
  process.exit(1)
}
const isAdmin = process.argv.includes('--admin')

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

async function main() {
  const user = await db.user.upsert({
    where: { githubLogin: login },
    update: { isSiteAdmin: isAdmin || undefined },
    create: {
      githubLogin: login,
      name: login,
      email: `${login}@dev.invalid`,
      isSiteAdmin: isAdmin,
      // Stable synthetic id: real sign-in would overwrite this with the true one.
      githubId: String(900_000_000 + (Math.abs(hash(login)) % 1_000_000)),
    },
  })

  const sessionToken = randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await db.session.create({ data: { sessionToken, userId: user.id, expires } })

  console.log(JSON.stringify({ userId: user.id, login, sessionToken, expires }, null, 2))
  console.log(`\nCookie header:\n  authjs.session-token=${sessionToken}`)
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
