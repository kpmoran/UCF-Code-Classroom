'use client'

import { useId, useRef, useState, type ReactNode } from 'react'

export type TabItem = {
  /** Stable key, also used to build the aria ids. */
  id: string
  label: string
  /** Rendered server-side and passed in, so these can be async server components. */
  content: ReactNode
  /** Optional count shown beside the label. */
  badge?: number
}

/**
 * A tab strip following the WAI-ARIA tabs pattern.
 *
 * Two decisions that are not obvious from the markup:
 *
 * **Every panel stays mounted, inactive ones hidden.** Rendering only the active
 * panel would throw away the repository table's search box and scroll position
 * every time someone checked a setting — and the content is server-rendered
 * either way, so nothing is saved by unmounting it.
 *
 * **Arrow keys move between tabs, with a roving tabindex.** Only the selected tab
 * is in the tab order; Left/Right (and Home/End) move within the strip, so Tab
 * moves *past* the strip to the panel rather than walking through every tab. This
 * is what the pattern requires and what screen-reader users expect, and it is the
 * part that is invariably left out when tabs are built from buttons and state.
 */
export function Tabs({
  tabs,
  label,
  defaultTabId,
}: {
  tabs: TabItem[]
  /** Names the tab strip for assistive technology. */
  label: string
  defaultTabId?: string
}) {
  const base = useId()
  const [active, setActive] = useState(defaultTabId ?? tabs[0]?.id)
  const stripRef = useRef<HTMLDivElement>(null)

  const tabId = (id: string) => `${base}-tab-${id}`
  const panelId = (id: string) => `${base}-panel-${id}`

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()

    const index = tabs.findIndex((t) => t.id === active)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length

    const target = tabs[next]
    if (!target) return
    setActive(target.id)
    // Follow focus, so the keyboard user lands on the tab they just selected.
    stripRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(target.id))}`)?.focus()
  }

  return (
    <div className="space-y-4">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-1 border-b border-border overflow-x-auto"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                selected
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-muted hover:text-foreground hover:border-border-strong'
              }`}
            >
              {tab.label}
              {tab.badge !== undefined ? (
                <span className="ml-2 tabular-nums text-xs text-muted">{tab.badge}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={panelId(tab.id)}
          role="tabpanel"
          aria-labelledby={tabId(tab.id)}
          hidden={tab.id !== active}
          // The panel itself is focusable so Tab from the strip lands somewhere
          // sensible even when the panel's first element is not interactive.
          tabIndex={0}
          className="space-y-6 focus:outline-none"
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
