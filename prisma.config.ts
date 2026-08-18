import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7 moved the datasource URL out of schema.prisma. The CLI reads it from
// here for migrate/introspect; the runtime client gets it via the pg driver
// adapter in src/lib/db.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
