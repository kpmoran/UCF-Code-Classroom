'use client'

import { useId, useMemo, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { filterTemplates, type TemplateOption } from '@/lib/github/templateMatch'

/**
 * Type-ahead over the organization's repositories.
 *
 * A controlled sibling of TemplateCombobox, for the panels that assign an existing
 * repository. The differences are why this is a separate component rather than a
 * prop on that one: the value lives in the parent (each row has its own field and
 * its own submit button), there is no form `name` because the panel builds its own
 * FormData, and the suggestions are loaded lazily and shared across every row
 * rather than fetched per instance.
 *
 * Filtering is `filterTemplates`, which is substring matching over the name and the
 * full `owner/repo` and is unit tested where it lives. Nothing about it is specific
 * to templates — the same reasoning applies here and more sharply, since these
 * names all begin with the organization login.
 *
 * Free text still submits: the field accepts anything and the server verifies it
 * against GitHub, so a repository the list has not caught up with is never blocked.
 */
export function RepoCombobox({
  value,
  onChange,
  onFirstFocus,
  options,
  loadState,
  orgLogin,
  ariaLabel,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  /** Called the first time the field is focused, so the parent can fetch once. */
  onFirstFocus: () => void
  options: readonly TemplateOption[]
  loadState: 'idle' | 'loading' | 'loaded' | 'failed'
  orgLogin: string
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const matches = useMemo(
    () => filterTemplates(options, value).slice(0, 50),
    [options, value],
  )

  function choose(option: TemplateOption) {
    onChange(option.fullName)
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
        return
      }
      if (matches.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + matches.length) % matches.length)
      return
    }

    // Only swallow Enter when a suggestion is highlighted, so Enter otherwise
    // reaches the Assign button the way it did before this field gained a menu.
    if (event.key === 'Enter' && open && active >= 0 && matches[active]) {
      event.preventDefault()
      choose(matches[active])
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  const activeId = active >= 0 && matches[active] ? `${listId}-${active}` : undefined

  return (
    <div className="relative flex-1">
      <Input
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        placeholder={`${orgLogin}/repo-name`}
        value={value}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        className="h-8 text-xs font-mono"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => {
          onFirstFocus()
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Deferred: clicking an option fires blur before the click handler, so
          // closing straight away would cancel the selection.
          blurTimer.current = setTimeout(() => setOpen(false), 120)
        }}
      />

      {open && matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          /*
           * Names the organization rather than repeating the word in the input's
           * own label. Accessible-name matching is by substring, and a menu label
           * that restates the field's label makes every locator for that field
           * ambiguous the moment the menu opens — which cost four end-to-end tests
           * once already.
           */
          aria-label={`Matches in ${orgLogin}`}
          className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-md border border-border-strong bg-surface shadow-lg py-1"
          onMouseDown={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current)
          }}
        >
          {matches.map((option, i) => (
            <li
              key={option.fullName}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`px-3 py-1.5 text-xs cursor-pointer font-mono ${
                i === active ? 'bg-surface-subtle' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(option)}
            >
              {option.name}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        * Only ever shown while the menu is open, and only when it has something to
        * say. A row per student means a permanent hint under each field would be
        * dozens of lines of the same sentence down the page.
        */}
      {open && loadState === 'loading' ? (
        <p className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow-lg">
          Looking up repositories in {orgLogin}… you can type the full name without waiting.
        </p>
      ) : open && loadState === 'failed' ? (
        <p className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow-lg">
          Could not reach GitHub for the list. Type the name — it is checked when you assign.
        </p>
      ) : open && loadState === 'loaded' && value.trim() !== '' && matches.length === 0 ? (
        <p className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow-lg">
          Nothing in {orgLogin} matches “{value.trim()}”.
        </p>
      ) : null}
    </div>
  )
}
