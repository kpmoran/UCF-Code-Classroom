'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { FieldHint, Input } from '@/components/ui/input'
import { filterTemplates, type TemplateOption } from '@/lib/github/templateMatch'

/**
 * Template repository picker.
 *
 * Replaces a `<datalist>`, which was the obvious choice and the wrong one:
 *
 *   * Safari renders it as a cramped dropdown that many people never notice, and
 *     historically ignored it entirely — so the "templates auto-populate" feature
 *     was invisible in the browser this course is likely to be marked in.
 *   * It matches on prefix. Typing "hw1" would not find
 *     "ucf-code-connect-sandbox/hw1-template", because the string starts with the
 *     organization. That is the *only* way anyone would type it.
 *
 * So: substring matching on the repository name and the full `owner/repo`, real
 * keyboard support, and consistent rendering everywhere.
 *
 * Free text still submits. Templates outside the organization are legitimate — the
 * field accepts any `owner/repo` — so this suggests without constraining, which is
 * why it is a combobox rather than a select.
 */
export function TemplateCombobox({
  name,
  orgLogin,
  loadTemplates,
  defaultValue = '',
  id,
}: {
  name: string
  orgLogin: string
  /**
   * Fetches the suggestions. Called once on mount rather than awaited during the
   * page render — see `getTemplateSuggestions` for why the render path is the
   * wrong place for it.
   */
  loadTemplates: () => Promise<TemplateOption[]>
  defaultValue?: string
  id: string
}) {
  const [value, setValue] = useState(defaultValue)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const listId = useId()
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /*
   * Loading into state, rather than suspending on a promise, so this input is a
   * single component instance for its whole life. A Suspense boundary here would
   * swap one input for another when the data arrived and take anything already
   * typed with it — the same class of bug as an uncontrolled field being reset by
   * a form action, and far more annoying, since it lands mid-sentence.
   */
  useEffect(() => {
    let cancelled = false
    loadTemplates()
      .then((found) => {
        if (cancelled) return
        setTemplates(found)
        setLoadState('loaded')
      })
      .catch(() => {
        if (!cancelled) setLoadState('failed')
      })
    return () => {
      cancelled = true
    }
    // Deliberately once per mount: the loader is bound to a classroom that cannot
    // change without navigating away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Filtering lives in lib/github/templateMatch.ts and is unit tested there; this
  // component is the wiring around it.
  const matches = useMemo(() => filterTemplates(templates, value), [templates, value])

  function choose(option: TemplateOption) {
    setValue(option.fullName)
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

    if (event.key === 'Enter' && open && active >= 0 && matches[active]) {
      // Only swallow Enter when a suggestion is actually highlighted, so Enter
      // still submits the form the rest of the time.
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
    <div className="relative">
      <Input
        id={id}
        name={name}
        // Not required: blank means "students get empty repositories", which is a
        // supported choice, so the browser must not block submission.
        autoComplete="off"
        spellCheck={false}
        placeholder={`${orgLogin}/hw1-template`}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        onChange={(e) => {
          setValue(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Deferred: a click on an option fires blur before the click handler, so
          // closing immediately would cancel the selection.
          blurTimer.current = setTimeout(() => setOpen(false), 120)
        }}
      />

      {open && matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          /*
           * Deliberately does not contain the word "Template": the input's own
           * label is "Template", accessible-name matching is by substring, and an
           * aria-label of "Template repositories" here made every
           * getByLabel('Template') ambiguous the moment this menu opened.
           */
          aria-label="Suggested repositories"
          className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-md border border-border-strong bg-surface shadow-lg py-1"
          onMouseDown={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current)
          }}
        >
          {matches.map((t, i) => (
            <li
              key={t.fullName}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`px-3 py-1.5 text-sm cursor-pointer ${
                i === active ? 'bg-surface-subtle' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(t)}
            >
              <span className="font-mono">{t.name}</span>
              {t.fullName !== `${orgLogin}/${t.name}` ? (
                <span className="text-muted"> — {t.fullName}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        * The field works identically in all four states below; only the advice changes.
        * "Loading" says what it is waiting for so that a slow GitHub looks like a slow
        * lookup rather than an empty organization.
        */}
      {loadState === 'loading' ? (
        <FieldHint>
          Looking up template repositories in {orgLogin}… you can type any{' '}
          <span className="font-mono">owner/repo</span> without waiting, or leave this
          blank to give each student an empty repository.
        </FieldHint>
      ) : loadState === 'failed' ? (
        <FieldHint>
          Could not reach GitHub for the list of templates in {orgLogin}. Type any{' '}
          <span className="font-mono">owner/repo</span> — it is checked when you submit —
          or leave it blank for empty repositories.
        </FieldHint>
      ) : templates.length > 0 ? (
        <FieldHint>
          {open && value.trim() !== '' && matches.length === 0
            ? `Nothing in ${orgLogin} matches “${value.trim()}”. You can still paste any owner/repo.`
            : `${templates.length} template repositor${templates.length === 1 ? 'y' : 'ies'} in ${orgLogin} — start typing to filter, paste any owner/repo, or leave blank for empty repositories.`}
        </FieldHint>
      ) : (
        <FieldHint>
          No template repositories found in {orgLogin}. Create one and tick “Template repository”
          in its GitHub settings, paste any <span className="font-mono">owner/repo</span> here, or
          leave this blank to give each student an empty repository.
        </FieldHint>
      )}
    </div>
  )
}
