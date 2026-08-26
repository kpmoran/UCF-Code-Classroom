import { Badge } from '@/components/ui/badge'
import type { SubmissionSummary } from '@/lib/deadlines/summary'

/**
 * What a student submitted, told to the student.
 *
 * Staff see this as a badge in a table; a student gets a sentence, because they
 * are reading it to answer a different question. An instructor is scanning twelve
 * rows for the one that needs attention. A student is asking "did my work count,
 * and which commit will be marked" — and the honest answer to the second half is a
 * link they can open, since a sha on its own tells them nothing.
 *
 * Deliberately silent before the deadline. Showing "not captured yet" to someone
 * still working reads as a warning about a problem they cannot act on.
 */
export function SubmissionSummaryPanel({
  submission,
  htmlUrl,
}: {
  submission: SubmissionSummary
  htmlUrl: string | null
}) {
  const { sha, late, locked, extended, deadline } = submission

  // Nothing has been recorded, so there is nothing to report. The deadline itself is
  // shown elsewhere on the page.
  if (sha === null) return null

  const due = deadline
    ? new Date(deadline).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">Your submission</span>
        {late ? <Badge tone="warning">late</Badge> : null}
        {extended ? <Badge tone="info">extended</Badge> : null}
        {locked ? <Badge tone="neutral">read-only</Badge> : null}
      </div>

      {sha === '' ? (
        <p className="text-sm text-muted">
          No commit was recorded {due ? `by ${due}` : 'by the deadline'}. If you pushed
          work after that, it is still in your repository — but this is what your
          instructor sees as submitted.
        </p>
      ) : (
        <p className="text-sm text-muted">
          {due ? `As of ${due}, your` : 'Your'} submitted commit is{' '}
          {htmlUrl ? (
            <a
              href={`${htmlUrl}/commit/${sha}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs underline underline-offset-2 hover:text-accent"
            >
              {sha.slice(0, 7)}
            </a>
          ) : (
            <span className="font-mono text-xs">{sha.slice(0, 7)}</span>
          )}
          . {late ? 'Work pushed after the deadline is not part of it.' : null}
        </p>
      )}

      {locked ? (
        <p className="text-xs text-muted">
          Your repository is read-only now that the deadline has passed. Ask your
          instructor if you need more time.
        </p>
      ) : null}
    </div>
  )
}
