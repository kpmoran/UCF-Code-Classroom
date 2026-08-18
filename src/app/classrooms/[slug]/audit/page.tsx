import Link from 'next/link'

import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { EmptyState, Table, TableWrap, Td, Th } from '@/components/ui/table'
import { requireInstructor } from '@/lib/auth/dal'
import { describeAuditAction, isDestructiveAction } from '@/lib/audit/describe'
import { db } from '@/lib/db'

const PAGE_SIZE = 100

/**
 * Activity log.
 *
 * Instructor-only, because it names students alongside what was done to them.
 * Append-only by design: this is the record that answers "who removed this
 * student's repository, and when", which is exactly the question that arises
 * weeks later during a grade dispute.
 */
export default async function AuditPage(props: PageProps<'/classrooms/[slug]/audit'>) {
  const { slug } = await props.params
  const search = await props.searchParams
  const { classroom } = await requireInstructor(slug)

  const page = Math.max(1, Number(search.page ?? '1') || 1)
  const skip = (page - 1) * PAGE_SIZE

  const [entries, total] = await Promise.all([
    db.auditLog.findMany({
      where: { classroomId: classroom.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true,
        action: true,
        detail: true,
        createdAt: true,
        actorUser: { select: { name: true, githubLogin: true } },
      },
    }),
    db.auditLog.count({ where: { classroomId: classroom.id } }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div>
              <h1 className="text-2xl font-semibold">Activity log</h1>
              <p className="text-sm text-muted mt-1">
                {total} recorded action{total === 1 ? '' : 's'}
                {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
              </p>
            </div>
            <ButtonLink href={`/classrooms/${classroom.slug}/people`} variant="outline" size="sm">
              People
            </ButtonLink>
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-border">
            <EmptyState
              title="Nothing recorded yet"
              description="Consequential actions — roster imports, removals, provisioning — are logged here as they happen."
            />
          </div>
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>What</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const detail = (e.detail ?? null) as Record<string, unknown> | null
                    const destructive = isDestructiveAction(e.action, detail)

                    return (
                      <tr key={e.id}>
                        <Td className="whitespace-nowrap text-xs text-muted align-top">
                          {e.createdAt.toLocaleString('en-US', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </Td>
                        <Td className="align-top text-sm">
                          {e.actorUser ? (
                            <span>
                              {e.actorUser.name ?? e.actorUser.githubLogin}
                              {e.actorUser.githubLogin ? (
                                <span className="block text-xs text-muted font-mono">
                                  @{e.actorUser.githubLogin}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            // Background jobs have no actor; the instructor's
                            // decision is logged separately at the point it was made.
                            <span className="text-xs text-muted">system</span>
                          )}
                        </Td>
                        <Td className="align-top text-sm">
                          <span className="flex items-start gap-2 flex-wrap">
                            <span>{describeAuditAction(e.action, detail)}</span>
                            {destructive ? <Badge tone="danger">destructive</Badge> : null}
                          </span>
                          {detail && Object.keys(detail).length > 0 ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-muted">
                                details
                              </summary>
                              <pre className="mt-1 overflow-x-auto rounded bg-surface-subtle p-2 text-xs font-mono">
                                {JSON.stringify(detail, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                          <span className="block text-xs text-muted font-mono mt-0.5">
                            {e.action}
                          </span>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            </TableWrap>

            {totalPages > 1 ? (
              <div className="flex justify-between">
                {page > 1 ? (
                  <ButtonLink
                    href={`/classrooms/${classroom.slug}/audit?page=${page - 1}`}
                    variant="outline"
                    size="sm"
                  >
                    ← Newer
                  </ButtonLink>
                ) : (
                  <span />
                )}
                {page < totalPages ? (
                  <ButtonLink
                    href={`/classrooms/${classroom.slug}/audit?page=${page + 1}`}
                    variant="outline"
                    size="sm"
                  >
                    Older →
                  </ButtonLink>
                ) : (
                  <span />
                )}
              </div>
            ) : null}
          </>
        )}
      </main>
    </>
  )
}
