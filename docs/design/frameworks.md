# Notes on Prisma 7 and Next.js 16

## Notes on Prisma 7

Prisma 7 removed `url` from the `datasource` block. The connection string now
lives in `prisma.config.ts` for CLI commands, and reaches the runtime client
through the `@prisma/adapter-pg` driver adapter in `src/lib/db.ts`. Two
constraints that Prisma cannot express — "an assignment repo belongs to exactly
one of a student or a team", and the same for extensions — are enforced by
hand-written SQL in `prisma/migrations/*_exclusive_owner_checks/`.

## Notes on Next.js 16

`middleware.ts` is now `proxy.ts` and runs on the Node.js runtime. Per the
Next.js authentication guide, proxy is used only for optimistic redirects;
real authorization happens in the data access layer (`requireClassroomRole`),
which every server action and page calls.
