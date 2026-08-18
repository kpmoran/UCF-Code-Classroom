import Papa from 'papaparse'

/**
 * Canvas Gradebook CSV → roster rows.
 *
 * Written to be tolerant, because a Canvas export is not one stable format. It
 * varies by Canvas version, by which SIS fields the institution populates, by
 * whether the instructor has permission to see SIS data, and by whether
 * assignment columns are included. Rather than assume a layout, this locates
 * identity columns by name and carries everything else through untouched.
 *
 * Two behaviours are deliberate and load-bearing:
 *
 *  - **Every column is preserved verbatim in `rawColumns`.** The Canvas grade
 *    *import* later has to reproduce the exact identity columns Canvas expects,
 *    and the only reliable source for those is the file Canvas produced.
 *
 *  - **Nothing is fabricated.** A missing SIS ID stays null rather than being
 *    derived, because a guessed identifier that happens to match another
 *    student would attach one student's repository to another's roster entry.
 */

export type ParsedRosterRow = {
  displayName: string
  sisUserId: string | null
  sisLoginId: string | null
  email: string | null
  section: string | null
  /** The source row, exactly as Canvas wrote it. */
  rawColumns: Record<string, string>
}

export type SkippedRow = {
  reason: string
  /** 1-based line number in the source file, for a useful error message. */
  line: number
  value: string
}

export type ParseRosterResult = {
  rows: ParsedRosterRow[]
  /** Header names recognised as identity columns, for the preview UI. */
  matchedColumns: Record<string, string | null>
  /** Header names carried through but not interpreted (assignment columns etc). */
  passthroughColumns: string[]
  warnings: string[]
  skipped: SkippedRow[]
}

export class RosterParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RosterParseError'
  }
}

/**
 * Candidate header names per logical field, in priority order. Compared after
 * normalising case, whitespace and punctuation, so "SIS User ID", "sis_user_id"
 * and "SIS  User Id" all match.
 */
const COLUMN_ALIASES = {
  displayName: ['student', 'name', 'studentname', 'fullname'],
  sisUserId: ['sisuserid', 'sisid', 'studentsisid'],
  sisLoginId: ['sisloginid', 'loginid', 'username'],
  email: ['email', 'emailaddress', 'studentemail', 'primaryemail'],
  section: ['section', 'sectionname', 'coursesection'],
} as const

type LogicalField = keyof typeof COLUMN_ALIASES

function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Rows Canvas includes that are not students.
 *
 * "Points Possible" is a metadata row Canvas emits second, with the label
 * indented by spaces. "Test Student" is the Student View dummy account, which
 * has no real GitHub user behind it.
 */
function nonStudentReason(displayName: string): string | null {
  const trimmed = displayName.trim().toLowerCase()
  if (trimmed === '' ) return 'no student name'
  if (trimmed === 'points possible') return 'Canvas “Points Possible” metadata row'
  if (trimmed === 'test student') return 'Canvas Student View test account'
  return null
}

export function parseRosterCsv(input: string): ParseRosterResult {
  // Papa handles quoted commas (which appear in every "Last, First" name),
  // embedded newlines, and CRLF. The BOM is stripped so the first header
  // matches; Canvas exports UTF-8 with BOM when downloaded from some browsers.
  const text = input.replace(/^﻿/, '')

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  if (!parsed.meta.fields || parsed.meta.fields.length === 0) {
    throw new RosterParseError(
      'That file has no header row. Export the roster from Canvas via ' +
        'Grades → Export, and upload the CSV unchanged.',
    )
  }

  const headers = parsed.meta.fields

  // Resolve each logical field to an actual header name.
  const matched: Record<LogicalField, string | null> = {
    displayName: null,
    sisUserId: null,
    sisLoginId: null,
    email: null,
    section: null,
  }

  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }))

  for (const field of Object.keys(COLUMN_ALIASES) as LogicalField[]) {
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = normalizedHeaders.find((h) => h.norm === alias)
      if (hit) {
        matched[field] = hit.raw
        break
      }
    }
  }

  if (!matched.displayName) {
    throw new RosterParseError(
      `Could not find a student name column. Expected one named “Student”, but the file has: ` +
        `${headers.slice(0, 8).join(', ')}${headers.length > 8 ? ', …' : ''}. ` +
        'Export via Grades → Export in Canvas and upload the file unchanged.',
    )
  }

  const identityHeaders = new Set(
    Object.values(matched).filter((h): h is string => h !== null),
  )
  const passthroughColumns = headers.filter((h) => !identityHeaders.has(h))

  const rows: ParsedRosterRow[] = []
  const skipped: SkippedRow[] = []
  const warnings: string[] = []

  const seenSisUserIds = new Map<string, string>()

  parsed.data.forEach((record, index) => {
    // +2: one for the header row, one to make it 1-based like an editor shows.
    const line = index + 2

    const displayName = (record[matched.displayName!] ?? '').trim()

    const reason = nonStudentReason(displayName)
    if (reason) {
      skipped.push({ reason, line, value: displayName })
      return
    }

    const value = (field: LogicalField): string | null => {
      const header = matched[field]
      if (!header) return null
      const raw = (record[header] ?? '').trim()
      return raw === '' ? null : raw
    }

    const sisUserId = value('sisUserId')

    if (sisUserId) {
      const existing = seenSisUserIds.get(sisUserId)
      if (existing) {
        skipped.push({
          reason: `duplicate SIS User ID, already used by “${existing}”`,
          line,
          value: displayName,
        })
        return
      }
      seenSisUserIds.set(sisUserId, displayName)
    }

    // Preserve the source row exactly, dropping only Papa's artefacts.
    const rawColumns: Record<string, string> = {}
    for (const header of headers) {
      rawColumns[header] = record[header] ?? ''
    }

    rows.push({
      displayName,
      sisUserId,
      sisLoginId: value('sisLoginId'),
      email: value('email'),
      section: value('section'),
      rawColumns,
    })
  })

  if (rows.length === 0) {
    throw new RosterParseError(
      'No student rows were found in that file. Check that it is a Canvas Gradebook ' +
        'export and that it contains enrolled students.',
    )
  }

  // Surface data-quality problems that will bite later rather than now.
  if (!matched.sisUserId) {
    warnings.push(
      'No “SIS User ID” column was found. Students will still be able to register, but ' +
        'grade export back to Canvas may not match rows reliably. If you have permission ' +
        'to view SIS data, re-export with it included.',
    )
  } else {
    const missing = rows.filter((r) => !r.sisUserId).length
    if (missing > 0) {
      warnings.push(
        `${missing} student${missing === 1 ? '' : 's'} have no SIS User ID. They can still ` +
          'register, but will need matching by hand on grade export.',
      )
    }
  }

  if (!matched.email) {
    warnings.push(
      'No email column was found, so students cannot be matched to their roster entry ' +
        'automatically — each will pick their own name from the list instead.',
    )
  }

  if (!matched.section) {
    warnings.push('No “Section” column was found, so students will not be grouped by section.')
  }

  return {
    rows,
    matchedColumns: matched,
    passthroughColumns,
    warnings,
    skipped,
  }
}
