import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Contrast guards for the design tokens.
 *
 * Written against globals.css itself rather than against a copy of the palette, so
 * it fails when someone edits a colour rather than when someone forgets to edit a
 * fixture. The theme has three token blocks — light, the dark media query, and the
 * explicit dark override — and the two dark ones must stay identical or the theme
 * toggle disagrees with the system preference.
 *
 * The border thresholds are the interesting ones. Borders are not text, so it is
 * easy to assume they have no requirement; WCAG 1.4.11 asks for 3:1 on the visual
 * information that identifies a component, and these were at 1.26:1 — drawn, but
 * not visibly.
 */

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')

/**
 * The token values from the block a selector opens.
 *
 * Scans every occurrence of the marker and takes the first that actually declares
 * colours: these selectors also appear near the top of the file inside Tailwind
 * `@custom-variant` definitions, which open a brace and define nothing, so taking
 * the first match silently yields an empty palette — and every assertion below
 * then compares undefined against undefined and passes.
 */
function block(marker: string): Record<string, string> {
  let from = 0
  for (;;) {
    const start = css.indexOf(marker, from)
    if (start === -1) break
    const open = css.indexOf('{', start)
    const end = css.indexOf('}', open)
    const out: Record<string, string> = {}
    for (const line of css.slice(open, end).split('\n')) {
      const m = line.match(/(--[a-z-]+):\s*(#[0-9a-f]{6})/i)
      if (m) out[m[1]] = m[2].toLowerCase()
    }
    if (Object.keys(out).length > 0) return out
    from = start + marker.length
  }
  throw new Error(`no token block found for ${marker}`)
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const light = block(':root {')
const darkMedia = block("@media (prefers-color-scheme: dark)")
const darkExplicit = block(":root[data-theme='dark']")

/** Text needs 4.5:1 (WCAG 1.4.3); non-text UI boundaries need 3:1 (1.4.11). */
const TEXT = 4.5
const UI = 3

describe.each([
  ['light', light],
  ['dark (system)', darkMedia],
  ['dark (explicit)', darkExplicit],
])('%s theme', (_name, t) => {
  // Every surface a bordered box can sit on. The subtle surface is the harder one
  // and the easier to forget, because most screenshots show a card on the page.
  const surfaces = () => [t['--background'], t['--surface'], t['--surface-subtle']]

  it('draws borders visibly enough to identify a component', () => {
    for (const bg of surfaces()) {
      expect(contrast(t['--border'], bg), `--border on ${bg}`).toBeGreaterThanOrEqual(UI)
      expect(
        contrast(t['--border-strong'], bg),
        `--border-strong on ${bg}`,
      ).toBeGreaterThanOrEqual(UI)
    }
  })

  it('keeps body and muted text readable on every surface', () => {
    for (const bg of surfaces()) {
      expect(contrast(t['--foreground'], bg), `--foreground on ${bg}`).toBeGreaterThanOrEqual(TEXT)
      expect(contrast(t['--muted'], bg), `--muted on ${bg}`).toBeGreaterThanOrEqual(TEXT)
    }
  })

  it('keeps the accent readable as text', () => {
    // --accent is only ever text or a border; fills use --accent-bright, which is
    // held to no text threshold because nothing is set in it.
    for (const bg of surfaces()) {
      expect(contrast(t['--accent'], bg), `--accent on ${bg}`).toBeGreaterThanOrEqual(TEXT)
    }
  })

  it('keeps each status colour readable on its own tint', () => {
    for (const tone of ['success', 'warning', 'danger', 'info']) {
      expect(
        contrast(t[`--${tone}`], t[`--${tone}-subtle`]),
        `--${tone} on --${tone}-subtle`,
      ).toBeGreaterThanOrEqual(TEXT)
    }
  })
})

it('states the dark palette identically in both places', () => {
  // They are separate blocks so an explicit choice can beat the system preference.
  // If they drift, the toggle changes colours rather than only which theme applies.
  expect(darkExplicit).toEqual(darkMedia)
})
