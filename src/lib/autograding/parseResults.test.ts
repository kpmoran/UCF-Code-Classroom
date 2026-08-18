import { describe, expect, it } from 'vitest'

import {
  parseResults,
  reconcileWithConfiguredTests,
  ResultsParseError,
} from './parseResults'

const VALID = JSON.stringify({
  version: 1,
  score: 20,
  maxScore: 100,
  tests: [
    { id: 'test_0', name: 'Compiles', passed: true, points: 20, maxPoints: 20, outcome: 'success' },
    { id: 'test_1', name: 'Unit tests', passed: false, points: 0, maxPoints: 80, outcome: 'failure' },
  ],
})

describe('parseResults — happy path', () => {
  const result = parseResults(VALID)

  it('reads the per-test results', () => {
    expect(result.tests).toHaveLength(2)
    expect(result.tests[0]).toEqual({
      id: 'test_0',
      name: 'Compiles',
      passed: true,
      points: 20,
      maxPoints: 20,
      outcome: 'success',
    })
  })

  it('computes the totals', () => {
    expect(result.score).toBe(20)
    expect(result.maxScore).toBe(100)
    expect(result.warnings).toEqual([])
  })
})

describe('parseResults — tampering', () => {
  /**
   * These are the cases that matter most: `results.json` arrives from a
   * student-controlled repository, where the workflow, the manifest and the
   * artifact itself can all be replaced.
   */

  it('recomputes the score rather than trusting the reported total', () => {
    const inflated = JSON.stringify({
      score: 100,
      maxScore: 100,
      tests: [
        { name: 'Compiles', passed: true, points: 20, maxPoints: 20 },
        { name: 'Unit tests', passed: false, points: 0, maxPoints: 80 },
      ],
    })
    const result = parseResults(inflated)
    expect(result.score).toBe(20)
    expect(result.warnings.some((w) => w.includes('reported a score of 100'))).toBe(true)
  })

  it('caps a test at its own maximum', () => {
    const result = parseResults(
      JSON.stringify({ tests: [{ name: 'Greedy', passed: true, points: 9999, maxPoints: 10 }] }),
    )
    expect(result.score).toBe(10)
    expect(result.warnings.some((w) => w.includes('capped at 10'))).toBe(true)
  })

  it('awards nothing for a failing test that claims points', () => {
    const result = parseResults(
      JSON.stringify({ tests: [{ name: 'Liar', passed: false, points: 50, maxPoints: 50 }] }),
    )
    expect(result.score).toBe(0)
    expect(result.warnings.some((w) => w.includes('marked as failing but claimed 50'))).toBe(true)
  })

  it('rejects negative points, which could offset another test', () => {
    const result = parseResults(
      JSON.stringify({
        tests: [
          { name: 'A', passed: true, points: -50, maxPoints: -50 },
          { name: 'B', passed: true, points: 30, maxPoints: 30 },
        ],
      }),
    )
    expect(result.score).toBe(30)
    expect(result.maxScore).toBe(30)
  })

  it('treats a non-boolean passed value as not passing', () => {
    // `passed: "true"` must not be truthy-coerced into a pass.
    const result = parseResults(
      JSON.stringify({ tests: [{ name: 'Sneaky', passed: 'true', points: 10, maxPoints: 10 }] }),
    )
    expect(result.tests[0].passed).toBe(false)
    expect(result.score).toBe(0)
  })

  it('clamps an absurd number of tests', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      name: `T${i}`,
      passed: true,
      points: 1,
      maxPoints: 1,
    }))
    const result = parseResults(JSON.stringify({ tests: many }))
    expect(result.tests).toHaveLength(200)
    expect(result.warnings.some((w) => w.includes('only the first 200'))).toBe(true)
  })

  it('rounds fractional points rather than accumulating drift', () => {
    const result = parseResults(
      JSON.stringify({ tests: [{ name: 'Frac', passed: true, points: 10.6, maxPoints: 11 }] }),
    )
    expect(result.score).toBe(11)
  })

  it('ignores non-finite numbers', () => {
    const result = parseResults('{"tests":[{"name":"NaN","passed":true,"points":1e999,"maxPoints":1e999}]}')
    expect(result.score).toBe(0)
    expect(result.maxScore).toBe(0)
  })
})

describe('parseResults — malformed input', () => {
  it('rejects invalid JSON with an explanation', () => {
    expect(() => parseResults('{ not json')).toThrow(ResultsParseError)
    expect(() => parseResults('{ not json')).toThrow(/not valid JSON/)
  })

  it('rejects a truncated file', () => {
    expect(() => parseResults(VALID.slice(0, 40))).toThrow(ResultsParseError)
  })

  it('rejects an array or a scalar at the top level', () => {
    expect(() => parseResults('[]')).toThrow(/not a JSON object/)
    expect(() => parseResults('"hello"')).toThrow(/not a JSON object/)
    expect(() => parseResults('null')).toThrow(/not a JSON object/)
  })

  it('rejects a file with no test list', () => {
    expect(() => parseResults('{"score":100}')).toThrow(/no test list/)
  })

  it('rejects a file whose tests are all unusable', () => {
    expect(() => parseResults('{"tests":[null,"x",5]}')).toThrow(/no usable tests/)
  })

  it('skips individual malformed entries but keeps the rest', () => {
    const result = parseResults(
      JSON.stringify({ tests: [null, { name: 'Good', passed: true, points: 5, maxPoints: 5 }] }),
    )
    expect(result.tests).toHaveLength(1)
    expect(result.score).toBe(5)
    expect(result.warnings.some((w) => w.includes('was not an object'))).toBe(true)
  })

  it('supplies a name when one is missing or blank', () => {
    const result = parseResults(
      JSON.stringify({ tests: [{ passed: true, points: 1, maxPoints: 1 }, { name: '   ', passed: false, maxPoints: 1 }] }),
    )
    expect(result.tests[0].name).toBe('Test 1')
    expect(result.tests[1].name).toBe('Test 2')
  })

  it('disambiguates duplicate names instead of merging them', () => {
    // Duplicates reach an instructor's screen and a Canvas export, where silently
    // collapsing two results would hide a failure.
    const result = parseResults(
      JSON.stringify({
        tests: [
          { name: 'Same', passed: true, points: 1, maxPoints: 1 },
          { name: 'Same', passed: false, points: 0, maxPoints: 1 },
          { name: 'Same', passed: true, points: 1, maxPoints: 1 },
        ],
      }),
    )
    expect(result.tests.map((t) => t.name)).toEqual(['Same', 'Same (2)', 'Same (3)'])
  })

  it('truncates an absurdly long name', () => {
    const result = parseResults(
      JSON.stringify({ tests: [{ name: 'x'.repeat(5000), passed: true, points: 1, maxPoints: 1 }] }),
    )
    expect(result.tests[0].name.length).toBeLessThanOrEqual(200)
  })
})

describe('reconcileWithConfiguredTests', () => {
  const configured = [
    { name: 'Compiles', points: 20 },
    { name: 'Unit tests', points: 80 },
  ]

  it('reports nothing when the run matches the assignment', () => {
    expect(reconcileWithConfiguredTests(parseResults(VALID), configured)).toEqual([])
  })

  it('detects an inflated points total from a modified manifest', () => {
    const tampered = parseResults(
      JSON.stringify({
        tests: [
          { name: 'Compiles', passed: true, points: 500, maxPoints: 500 },
          { name: 'Unit tests', passed: true, points: 500, maxPoints: 500 },
        ],
      }),
    )
    const problems = reconcileWithConfiguredTests(tampered, configured)
    expect(problems.some((p) => p.includes('1000 points available'))).toBe(true)
    expect(problems.some((p) => p.includes('may have been modified'))).toBe(true)
  })

  it('detects a removed test', () => {
    const partial = parseResults(
      JSON.stringify({ tests: [{ name: 'Compiles', passed: true, points: 20, maxPoints: 20 }] }),
    )
    const problems = reconcileWithConfiguredTests(partial, configured)
    expect(problems.some((p) => p.includes('reports 1 test'))).toBe(true)
  })

  it('detects an unrecognised test name', () => {
    const renamed = parseResults(
      JSON.stringify({
        tests: [
          { name: 'Compiles', passed: true, points: 20, maxPoints: 20 },
          { name: 'Free marks', passed: true, points: 80, maxPoints: 80 },
        ],
      }),
    )
    const problems = reconcileWithConfiguredTests(renamed, configured)
    expect(problems.some((p) => p.includes('Free marks'))).toBe(true)
  })

  it('says nothing when the assignment has no configured tests', () => {
    expect(reconcileWithConfiguredTests(parseResults(VALID), [])).toEqual([])
  })
})
