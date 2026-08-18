/**
 * Parse the `results.json` produced by the autograding workflow.
 *
 * Written defensively because the file arrives from a **student-controlled
 * repository**. A student can edit the workflow, replace the manifest, or upload a
 * hand-written artifact claiming full marks. This parser therefore treats the file
 * as untrusted input: it validates shape, clamps numbers, and — crucially —
 * recomputes the score from the per-test results rather than trusting the totals
 * the file reports.
 *
 * The caller is responsible for the remaining half of that problem: comparing
 * `maxScore` against the assignment's configured points, so a tampered manifest
 * is visible rather than silently authoritative.
 */

export type ParsedTestResult = {
  id: string | null
  name: string
  passed: boolean
  points: number
  maxPoints: number
  outcome: string | null
}

export type ParsedResults = {
  /** Recomputed from the tests, never taken from the file. */
  score: number
  maxScore: number
  tests: ParsedTestResult[]
  /** Problems worth showing an instructor; not fatal. */
  warnings: string[]
}

export class ResultsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResultsParseError'
  }
}

/** Hard ceilings, so a malformed file cannot produce absurd marks or huge rows. */
const MAX_TESTS = 200
const MAX_POINTS_PER_TEST = 10_000
const MAX_NAME_LENGTH = 200

function clampPoints(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  // Negative points would let a crafted file reduce another test's contribution.
  return Math.max(0, Math.min(MAX_POINTS_PER_TEST, Math.round(value)))
}

function asString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, MAX_NAME_LENGTH)
}

export function parseResults(raw: string): ParsedResults {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ResultsParseError(
      'The autograding results file was not valid JSON. The grading workflow may have failed ' +
        'before it finished writing results.',
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ResultsParseError('The autograding results file was not a JSON object.')
  }

  const record = parsed as Record<string, unknown>
  const warnings: string[] = []

  const rawTests = record.tests
  if (!Array.isArray(rawTests)) {
    throw new ResultsParseError(
      'The autograding results file contained no test list, so no score could be read.',
    )
  }

  if (rawTests.length > MAX_TESTS) {
    warnings.push(
      `The results file listed ${rawTests.length} tests; only the first ${MAX_TESTS} were read.`,
    )
  }

  const tests: ParsedTestResult[] = []
  const seenNames = new Set<string>()

  rawTests.slice(0, MAX_TESTS).forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`Test ${index + 1} in the results file was not an object and was skipped.`)
      return
    }
    const test = entry as Record<string, unknown>

    const name = asString(test.name, `Test ${index + 1}`)
    // Names reach an instructor's screen and a Canvas export, so duplicates are
    // disambiguated rather than silently merged.
    let uniqueName = name
    let suffix = 2
    while (seenNames.has(uniqueName)) {
      uniqueName = `${name} (${suffix++})`
    }
    seenNames.add(uniqueName)

    const maxPoints = clampPoints(test.maxPoints)
    const claimedPoints = clampPoints(test.points)
    const passed = test.passed === true

    // A test cannot earn more than it is worth, and a failing test earns nothing
    // whatever the file claims.
    const points = passed ? Math.min(claimedPoints, maxPoints) : 0

    if (passed && claimedPoints > maxPoints) {
      warnings.push(
        `“${uniqueName}” claimed ${claimedPoints} of ${maxPoints} points; capped at ${maxPoints}.`,
      )
    }
    if (!passed && claimedPoints > 0) {
      warnings.push(`“${uniqueName}” was marked as failing but claimed ${claimedPoints} points.`)
    }

    tests.push({
      id: typeof test.id === 'string' ? test.id : null,
      name: uniqueName,
      passed,
      points,
      maxPoints,
      outcome: typeof test.outcome === 'string' ? test.outcome : null,
    })
  })

  if (tests.length === 0) {
    throw new ResultsParseError('The autograding results file listed no usable tests.')
  }

  // Recomputed, deliberately. The file's own `score` and `maxScore` are ignored
  // because they are the easiest values for a student to inflate.
  const score = tests.reduce((sum, test) => sum + test.points, 0)
  const maxScore = tests.reduce((sum, test) => sum + test.maxPoints, 0)

  const reportedScore = record.score
  if (typeof reportedScore === 'number' && Math.round(reportedScore) !== score) {
    warnings.push(
      `The results file reported a score of ${reportedScore} but the per-test results add up ` +
        `to ${score}. The recomputed total was used.`,
    )
  }

  return { score, maxScore, tests, warnings }
}

/**
 * Compare a parsed run against the assignment's configured tests.
 *
 * This is what catches a student who edited the manifest to inflate the available
 * points or removed a failing test. It reports rather than rejects: the
 * instructor decides what a mismatch means.
 */
export function reconcileWithConfiguredTests(
  parsed: ParsedResults,
  configured: ReadonlyArray<{ name: string; points: number }>,
): string[] {
  if (configured.length === 0) return []

  const problems: string[] = []
  const expectedMax = configured.reduce((sum, test) => sum + test.points, 0)

  if (parsed.maxScore !== expectedMax) {
    problems.push(
      `This run reports ${parsed.maxScore} points available, but the assignment defines ` +
        `${expectedMax}. The workflow or its manifest may have been modified in the ` +
        'student’s repository.',
    )
  }

  if (parsed.tests.length !== configured.length) {
    problems.push(
      `This run reports ${parsed.tests.length} test${parsed.tests.length === 1 ? '' : 's'}, ` +
        `but the assignment defines ${configured.length}.`,
    )
  }

  const configuredNames = new Set(configured.map((t) => t.name))
  const unexpected = parsed.tests.filter((t) => !configuredNames.has(t.name)).map((t) => t.name)
  if (unexpected.length > 0) {
    problems.push(`Unrecognised test name(s): ${unexpected.slice(0, 5).join(', ')}.`)
  }

  return problems
}
