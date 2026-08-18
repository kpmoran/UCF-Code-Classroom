import { describe, expect, it } from 'vitest'

import {
  buildGradeCsv,
  columnTitle,
  gradeCsvFilename,
  resolveScore,
  type ExportRow,
} from './exportGrades'
import { CANVAS_AWKWARD_NAMES, CANVAS_STANDARD } from './fixtures'
import { parseRosterCsv } from './parseRoster'

function rowFrom(raw: Record<string, string>, scores: Record<string, number | null> = {}): ExportRow {
  return { rawColumns: raw, displayName: raw.Student ?? '', scores }
}

const STANDARD_RAW = {
  Student: 'Alvarez, Ava',
  ID: '4001',
  'SIS User ID': '30000001',
  'SIS Login ID': 'av123456',
  Section: 'COP4331-0001',
}

describe('buildGradeCsv — structure', () => {
  it('emits Canvas identity columns in Canvas order, then assignments', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { 'Homework 1': 92 })],
      [{ title: 'Homework 1', pointsPossible: 100 }],
    )
    const [header] = csv.split('\r\n')
    expect(header).toBe('Student,ID,SIS User ID,SIS Login ID,Section,Homework 1')
  })

  it('writes identity values verbatim from the source export', () => {
    // Reconstructing these from normalized fields is what makes Canvas create a
    // duplicate row instead of matching an existing student.
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { 'Homework 1': 92 })],
      [{ title: 'Homework 1', pointsPossible: 100 }],
    )
    expect(csv).toContain('"Alvarez, Ava",4001,30000001,av123456,COP4331-0001,92')
  })

  it('omits the Points Possible row by default', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { HW: 10 })],
      [{ title: 'HW', pointsPossible: 10 }],
    )
    expect(csv).not.toContain('Points Possible')
  })

  it('includes the Points Possible row when asked', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { HW: 8 })],
      [{ title: 'HW', pointsPossible: 10 }],
      { includePointsPossible: true },
    )
    const lines = csv.split('\r\n')
    // Quoted because of the leading whitespace Canvas puts in the label — that
    // quoting is required for the spaces to survive a round trip.
    expect(lines[1]).toBe('"    Points Possible",,,,,10')
  })

  it('uses CRLF line endings', () => {
    const csv = buildGradeCsv([rowFrom(STANDARD_RAW)], [])
    expect(csv).toContain('\r\n')
    expect(csv.split('\r\n').length).toBeGreaterThan(1)
  })

  it('supports several assignment columns', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { 'HW 1': 90, 'HW 2': 75, Project: null })],
      [
        { title: 'HW 1', pointsPossible: 100 },
        { title: 'HW 2', pointsPossible: 100 },
        { title: 'Project', pointsPossible: 200 },
      ],
    )
    const [header, row] = csv.split('\r\n')
    expect(header.endsWith('HW 1,HW 2,Project')).toBe(true)
    expect(row.endsWith('90,75,')).toBe(true)
  })
})

describe('buildGradeCsv — missing scores', () => {
  it('leaves a cell empty rather than writing zero', () => {
    // An empty cell means "no change" to Canvas. A 0 actively records a zero,
    // which would fail every student who has not submitted yet.
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { HW: null })],
      [{ title: 'HW', pointsPossible: 100 }],
    )
    expect(csv.split('\r\n')[1]).toMatch(/,$/)
    expect(csv).not.toContain(',0')
  })

  it('treats an absent key the same as an explicit null', () => {
    const csv = buildGradeCsv([rowFrom(STANDARD_RAW, {})], [{ title: 'HW', pointsPossible: 100 }])
    expect(csv.split('\r\n')[1]).toMatch(/,$/)
  })

  it('does write a genuine zero when that is the score', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { HW: 0 })],
      [{ title: 'HW', pointsPossible: 100 }],
    )
    expect(csv.split('\r\n')[1].endsWith(',0')).toBe(true)
  })
})

describe('buildGradeCsv — awkward data', () => {
  it('quotes names containing commas and quotes so the row still parses', () => {
    const parsed = parseRosterCsv(CANVAS_AWKWARD_NAMES)
    const rows = parsed.rows.map((r) => rowFrom(r.rawColumns, { HW: 50 }))
    const csv = buildGradeCsv(rows, [{ title: 'HW', pointsPossible: 100 }])

    // Round-trip through the parser: every original name must survive intact.
    const reparsed = parseRosterCsv(csv)
    expect(reparsed.rows.map((r) => r.displayName)).toEqual(
      parsed.rows.map((r) => r.displayName),
    )
    expect(reparsed.rows.map((r) => r.displayName)).toContain('Smith Jr., Robert "Bob"')
    expect(reparsed.rows.map((r) => r.displayName)).toContain('学生, 中文')
  })

  it('quotes an assignment title containing a comma', () => {
    const csv = buildGradeCsv(
      [rowFrom(STANDARD_RAW, { 'HW 1, part 2': 10 })],
      [{ title: 'HW 1, part 2', pointsPossible: 10 }],
    )
    expect(csv.split('\r\n')[0]).toContain('"HW 1, part 2"')
    // And it still parses back to the same header.
    const reparsed = parseRosterCsv(csv)
    expect(reparsed.passthroughColumns).toContain('HW 1, part 2')
  })

  it('preserves an empty SIS field rather than dropping the column', () => {
    // Canvas distinguishes an empty SIS field from an absent one when matching.
    const raw = { ...STANDARD_RAW, 'SIS User ID': '' }
    const csv = buildGradeCsv([rowFrom(raw, { HW: 5 })], [{ title: 'HW', pointsPossible: 10 }])
    expect(csv.split('\r\n')[0]).toContain('SIS User ID')
    expect(csv.split('\r\n')[1]).toBe('"Alvarez, Ava",4001,,av123456,COP4331-0001,5')
  })

  it('synthesizes a Student column when the source export lacked one', () => {
    const row: ExportRow = {
      rawColumns: { ID: '4001' },
      displayName: 'Fallback, Name',
      scores: { HW: 3 },
    }
    const csv = buildGradeCsv([row], [{ title: 'HW', pointsPossible: 10 }])
    expect(csv.split('\r\n')[0].startsWith('Student,ID')).toBe(true)
    expect(csv).toContain('"Fallback, Name"')
  })

  it('handles an empty roster without producing a broken file', () => {
    const csv = buildGradeCsv([], [{ title: 'HW', pointsPossible: 10 }])
    // Header only. A zero-byte file — which the CSV library produces by default
    // for an empty record list — is rejected by Canvas with an unhelpful message.
    const lines = csv.split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('Student,ID,SIS User ID,SIS Login ID,Section,HW')
  })
})

describe('import → export round trip', () => {
  it('reproduces the identity columns byte-for-byte', () => {
    /**
     * The invariant the whole design rests on: a roster imported from Canvas and
     * exported back must present the same identity columns, so Canvas matches
     * existing students instead of creating duplicates.
     */
    const parsed = parseRosterCsv(CANVAS_STANDARD)
    const rows = parsed.rows.map((r) => rowFrom(r.rawColumns, { 'New Assignment': 88 }))
    const csv = buildGradeCsv(rows, [{ title: 'New Assignment', pointsPossible: 100 }])

    const reparsed = parseRosterCsv(csv)

    for (const [index, original] of parsed.rows.entries()) {
      const exported = reparsed.rows[index]
      expect(exported.displayName).toBe(original.displayName)
      expect(exported.sisUserId).toBe(original.sisUserId)
      expect(exported.sisLoginId).toBe(original.sisLoginId)
      expect(exported.section).toBe(original.section)
      // The Canvas-internal ID must survive too — it is what Canvas matches on
      // first.
      expect(exported.rawColumns.ID).toBe(original.rawColumns.ID)
    }
  })

  it('does not carry the original assignment columns into the export', () => {
    // Re-exporting Homework 1 from the imported file would overwrite grades the
    // instructor may have since changed in Canvas.
    const parsed = parseRosterCsv(CANVAS_STANDARD)
    const rows = parsed.rows.map((r) => rowFrom(r.rawColumns, { 'New Assignment': 88 }))
    const csv = buildGradeCsv(rows, [{ title: 'New Assignment', pointsPossible: 100 }])

    expect(csv).not.toContain('Homework 1 (901234)')
    expect(csv).not.toContain('Current Score')
  })
})

describe('columnTitle', () => {
  it('trims and collapses whitespace', () => {
    // Canvas matches assignments by exact title; a stray double space creates a
    // second assignment instead of filling in the existing one.
    expect(columnTitle('  Homework   1  ')).toBe('Homework 1')
    expect(columnTitle('Homework\t1')).toBe('Homework 1')
  })

  it('leaves an already-clean title alone', () => {
    expect(columnTitle('Homework 1')).toBe('Homework 1')
  })
})

describe('resolveScore', () => {
  it('prefers a manual override', () => {
    // The override exists precisely because the automatic number was wrong.
    expect(
      resolveScore({ manualScore: 95, autogradeScore: 30, autogradeStatus: 'COMPLETED' }),
    ).toBe(95)
  })

  it('uses a completed autograde score', () => {
    expect(
      resolveScore({ manualScore: null, autogradeScore: 30, autogradeStatus: 'COMPLETED' }),
    ).toBe(30)
  })

  it('ignores an incomplete or failed autograde run', () => {
    // A failed run means "we have no result", not "the student scored nothing".
    expect(
      resolveScore({ manualScore: null, autogradeScore: 0, autogradeStatus: 'FAILED' }),
    ).toBeNull()
    expect(
      resolveScore({ manualScore: null, autogradeScore: 10, autogradeStatus: 'RUNNING' }),
    ).toBeNull()
  })

  it('returns null when there is nothing to report', () => {
    expect(
      resolveScore({ manualScore: null, autogradeScore: null, autogradeStatus: null }),
    ).toBeNull()
  })

  it('honours a manual zero, which is a real grade', () => {
    expect(
      resolveScore({ manualScore: 0, autogradeScore: 100, autogradeStatus: 'COMPLETED' }),
    ).toBe(0)
  })
})

describe('gradeCsvFilename', () => {
  it('includes the classroom and date', () => {
    expect(gradeCsvFilename('cop4331-fall-2026', new Date(2026, 7, 17))).toBe(
      'cop4331-fall-2026-grades-2026-08-17.csv',
    )
  })

  it('zero-pads month and day', () => {
    expect(gradeCsvFilename('x', new Date(2026, 0, 5))).toBe('x-grades-2026-01-05.csv')
  })
})
