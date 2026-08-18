'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { FieldHint, Input } from '@/components/ui/input'
import { joinClassroom, type JoinResult } from '@/lib/roster/joinAction'
import type { ClaimableEntry } from '@/lib/roster/join'

function ConfirmButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="lg" disabled={pending || disabled}>
      {pending ? 'Linking…' : 'This is me — join classroom'}
    </Button>
  )
}

/**
 * Roster self-identification.
 *
 * The student picks their own name. There is no dependable automatic mapping
 * from a GitHub account to a university identity, and a wrong guess would attach
 * one student's submissions to another's record — so the choice is explicit and
 * confirmed, with any email match offered only as a suggestion.
 */
export function JoinClassroomForm({
  token,
  entries,
  suggestedId,
  totalClaimed,
}: {
  token: string
  entries: ClaimableEntry[]
  suggestedId: string | null
  totalClaimed: number
}) {
  const [selected, setSelected] = useState<string | null>(suggestedId)
  const [query, setQuery] = useState('')
  const [state, formAction] = useActionState(
    async (_prev: JoinResult | null, formData: FormData) => joinClassroom(formData),
    null,
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.displayName.toLowerCase().includes(q))
  }, [entries, query])

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="entryId" value={selected ?? ''} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {state.error}
        </p>
      ) : null}

      {suggestedId ? (
        <p className="text-sm rounded-md bg-info-subtle text-info px-3 py-2">
          We matched your email to a name on the roster and preselected it. Check that it is
          right before continuing.
        </p>
      ) : null}

      <div>
        <Input
          aria-label="Search for your name"
          placeholder="Type your last name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <FieldHint>
          Names are listed as they appear in Canvas, usually “Last, First”.
          {totalClaimed > 0
            ? ` ${totalClaimed} classmate${totalClaimed === 1 ? '' : 's'} already joined.`
            : ''}
        </FieldHint>
      </div>

      <fieldset
        className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border"
        aria-label="Choose your name"
      >
        {filtered.length === 0 ? (
          <p className="text-sm text-muted px-3 py-4">
            No unclaimed names match “{query}”. If your name is missing, your instructor may
            not have imported the latest roster.
          </p>
        ) : (
          filtered.map((entry) => (
            <label
              key={entry.id}
              className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer text-sm hover:bg-surface-subtle ${
                selected === entry.id ? 'bg-surface-subtle' : ''
              }`}
            >
              <input
                type="radio"
                name="entryChoice"
                value={entry.id}
                checked={selected === entry.id}
                onChange={() => setSelected(entry.id)}
              />
              <span className="flex-1 min-w-0">
                <span className="font-medium">{entry.displayName}</span>
                <span className="block text-xs text-muted">
                  {[entry.section, entry.hint].filter(Boolean).join(' · ') || ' '}
                </span>
              </span>
            </label>
          ))
        )}
      </fieldset>

      <div className="space-y-2">
        <ConfirmButton disabled={!selected} />
        <p className="text-xs text-muted">
          Pick carefully — this links your GitHub account to that student record. If you
          choose wrongly, your instructor can unlink it.
        </p>
      </div>
    </form>
  )
}
