'use client'

import { useSyncExternalStore } from 'react'

export const THEME_STORAGE_KEY = 'uccc-theme'

type Choice = 'system' | 'light' | 'dark'

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: 'system', label: 'Auto', hint: 'Follow my system setting' },
  { value: 'light', label: 'Light', hint: 'Always use the light theme' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme' },
]

/**
 * The stored choice, read as an external store rather than copied into state by an
 * effect.
 *
 * `useSyncExternalStore` is what React provides for exactly this: it has a defined
 * server snapshot, so there is no hydration mismatch to paper over, and no
 * setState-in-an-effect. Subscribing to `storage` also syncs other tabs for free,
 * which is the behaviour a reader expects — changing the theme in one tab and finding
 * the others disagree looks like a bug.
 */
const listeners = new Set<() => void>()

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  // Fires for changes made by *other* tabs only, hence the local set as well.
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

function getSnapshot(): Choice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

// Server-rendered markup cannot know the reader's choice, and the inline script in
// layout.tsx has already applied it to <html> by the time this hydrates.
const getServerSnapshot = (): Choice => 'system'

function apply(choice: Choice) {
  const root = document.documentElement
  // Absent means "follow the system", which is what the CSS media query handles.
  // A data-theme of "system" would be a third state the stylesheet does not know.
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/**
 * Light / dark / follow-the-system.
 *
 * Three options rather than a two-way switch, because "follow my system" is a real
 * preference and not the same as either fixed choice. A binary toggle discards it the
 * first time you touch the control, with no way back.
 *
 * A radio group, so it announces as one control with three options and arrow keys move
 * between them. A single cycling button would announce only its current state and give
 * no indication of what pressing it does — which matters most for the readers a theme
 * control exists to serve.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  function choose(next: Choice) {
    apply(next)
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
      else window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Safari in private browsing throws on write. The theme still applies to this
      // page; only remembering it fails, which is not worth interrupting anyone over.
    }
    listeners.forEach((l) => l())
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center rounded-md border border-border p-0.5 gap-0.5"
    >
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={choice === c.value}
          aria-label={c.hint}
          title={c.hint}
          onClick={() => choose(c.value)}
          className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
            choice === c.value
              ? 'bg-accent-bright text-accent-contrast'
              : 'text-muted hover:bg-surface-subtle'
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}
