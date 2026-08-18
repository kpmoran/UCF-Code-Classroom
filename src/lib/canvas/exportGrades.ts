import Papa from 'papaparse'

/**
 * Build a Canvas Gradebook import CSV.
 *
 * Canvas matches rows on the identity columns it emitted — `Student`, `ID`,
 * `SIS User ID`, `SIS Login ID`, `Section`. Those are reproduced **verbatim from
 * the file Canvas produced**, which is why roster import retains every source
 * column in `rawColumns`. Reconstructing them from our own normalized fields would
 * work right up until a student's name contained something we normalized away, at
 * which point Canvas would silently create a second row rather than match.
 *
 * Pure so the exact bytes are testable.
 */

/** Canvas identity columns, in the order it emits them. */
const IDENTITY_COLUMNS = [
  'Student',
  'ID',
  'SIS User ID',
  'SIS Login ID',
  'Section',
] as const

/**
 * The metadata row Canvas writes second in every export, and expects back on
 * import when assignment columns carry point values.
 */
const POINTS_POSSIBLE_LABEL = '    Points Possible'

export type ExportRow = {
  /** The student's original CSV row, exactly as Canvas produced it. */
  rawColumns: Record<string, string>
  displayName: string
  /** Score per assignment column, keyed by the column title. Null means no submission. */
  scores: Record<string, number | null>
}

export type ExportColumn = {
  /** Column title as it will appear in Canvas. */
  title: string
  pointsPossible: number
}

export type ExportOptions = {
  /**
   * Emit the "Points Possible" row. Canvas accepts an import without it, but then
   * treats the assignment's existing point value as authoritative — which is the
   * safer default when the instructor may have edited it in Canvas.
   */
  includePointsPossible?: boolean
}

/**
 * A Canvas-safe assignment column title.
 *
 * Canvas matches an existing assignment by title. A title containing a comma or
 * quote still round-trips because the CSV is properly quoted, but a title that
 * differs from the Canvas assignment — even by whitespace — creates a *new*
 * assignment on import rather than filling in the existing one.
 */
export function columnTitle(assignmentTitle: string): string {
  return assignmentTitle.trim().replace(/\s+/g, ' ')
}

export function buildGradeCsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  options: ExportOptions = {},
): string {
  /**
   * Identity columns present in the source data, in Canvas's order.
   *
   * With no rows there is nothing to inspect, so the full standard set is used —
   * otherwise an empty roster would export a header of just `Student` plus the
   * assignment columns, which does not look like a Canvas file and gives an
   * instructor no clue what they are looking at.
   */
  const presentIdentity =
    rows.length === 0
      ? [...IDENTITY_COLUMNS]
      : IDENTITY_COLUMNS.filter((name) => rows.some((row) => name in row.rawColumns))

  // `Student` is required for Canvas to render the file at all; synthesize it from
  // the display name when the original export somehow lacked it.
  const header: string[] = presentIdentity.includes('Student')
    ? [...presentIdentity]
    : ['Student', ...presentIdentity]

  for (const column of columns) header.push(column.title)

  const records: Array<Record<string, string>> = []

  if (options.includePointsPossible) {
    const metadata: Record<string, string> = {}
    for (const name of header) metadata[name] = ''
    metadata.Student = POINTS_POSSIBLE_LABEL
    for (const column of columns) metadata[column.title] = String(column.pointsPossible)
    records.push(metadata)
  }

  for (const row of rows) {
    const record: Record<string, string> = {}

    for (const name of header) {
      if (name === 'Student') {
        record[name] = row.rawColumns.Student ?? row.displayName
        continue
      }
      // Verbatim, including empty strings — Canvas distinguishes an empty SIS
      // field from an absent one when matching.
      record[name] = row.rawColumns[name] ?? ''
    }

    for (const column of columns) {
      const score = row.scores[column.title]
      // An empty cell means "no change" to Canvas, which is what we want for a
      // student who never submitted. Writing 0 would actively record a zero.
      record[column.title] = score === null || score === undefined ? '' : String(score)
    }

    records.push(record)
  }

  // Papa emits an empty string for an empty record list, dropping the header with
  // it — so an export with nobody on the roster would download as a zero-byte
  // file, which Canvas rejects with an unhelpful message. Emit the header alone
  // instead, which Canvas accepts as a no-op.
  if (records.length === 0) {
    return Papa.unparse([header], { newline: '\r\n' })
  }

  // `newline` forced to CRLF: Canvas is tolerant, but Excel — which most
  // instructors open the file in first — is not consistently so.
  return Papa.unparse(records, { columns: header, newline: '\r\n' })
}

/** Suggested filename, e.g. `cop4331-fall-2026-grades-2026-08-17.csv`. */
export function gradeCsvFilename(classroomSlug: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `${classroomSlug}-grades-${stamp}.csv`
}

/**
 * Choose the score for one repository.
 *
 * A manual override always wins: it is the instructor's explicit judgement, entered
 * precisely because the automatic number was wrong or absent. Autograding supplies
 * the number otherwise, and a repository with neither exports as blank rather than
 * as zero.
 */
export function resolveScore(input: {
  manualScore: number | null
  autogradeScore: number | null
  autogradeStatus: string | null
}): number | null {
  if (input.manualScore !== null) return input.manualScore
  if (input.autogradeStatus === 'COMPLETED' && input.autogradeScore !== null) {
    return input.autogradeScore
  }
  return null
}
