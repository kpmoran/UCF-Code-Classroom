import { stringify } from 'yaml'

/**
 * Render the autograding GitHub Actions workflow for an assignment.
 *
 * Two files are produced, and the split is the whole point of the design:
 *
 *   `.github/workflows/uccc-autograding.yml`  the workflow
 *   `.github/uccc-autograding.json`           the test manifest
 *
 * Test *names* and point values live in the manifest, never in shell source. The
 * collector reads the manifest as data and the per-step outcomes from environment
 * variables, so a test called `"; rm -rf /` is inert. Interpolating names into a
 * `run:` block — the obvious implementation — would execute them in the student's
 * repository with a checkout already present.
 *
 * The YAML itself is produced by a serializer rather than a template, so quoting
 * and escaping are handled correctly for every name an instructor can type.
 */

export const WORKFLOW_PATH = '.github/workflows/uccc-autograding.yml'
export const MANIFEST_PATH = '.github/uccc-autograding.json'
export const RESULTS_ARTIFACT_NAME = 'uccc-autograding-results'
export const RESULTS_FILE_NAME = 'results.json'

export type GradingTestSpec = {
  id: string
  name: string
  setupCommand: string | null
  runCommand: string
  timeoutMinutes: number
  points: number
}

export type RenderedWorkflow = {
  workflowYaml: string
  manifestJson: string
}

/** Step id for a test. Must be a valid Actions id and env-var suffix. */
export function stepIdFor(index: number): string {
  return `test_${index}`
}

/**
 * The results collector.
 *
 * A quoted heredoc (`<<'PY'`) so the shell performs no substitution inside, and
 * the manifest path arrives as an argument. Nothing instructor-authored is ever
 * part of this script's source.
 */
const COLLECT_SCRIPT = `set -euo pipefail
python3 - "$MANIFEST" > "$RESULTS" <<'PY'
import json, os, sys

with open(os.environ["MANIFEST"]) as handle:
    manifest = json.load(handle)

results = []
score = 0
max_score = 0

for test in manifest["tests"]:
    # Actions reports 'success', 'failure', 'cancelled' or 'skipped'. Anything
    # other than success counts as not passing; a missing variable means the step
    # never ran at all.
    outcome = os.environ.get("OUTCOME_" + test["id"], "skipped")
    passed = outcome == "success"
    points = test["points"] if passed else 0

    results.append({
        "id": test["id"],
        "name": test["name"],
        "passed": passed,
        "points": points,
        "maxPoints": test["points"],
        "outcome": outcome,
    })
    score += points
    max_score += test["points"]

json.dump(
    {
        "version": 1,
        "score": score,
        "maxScore": max_score,
        "tests": results,
    },
    sys.stdout,
    indent=2,
)
PY
echo "--- autograding results ---"
cat "$RESULTS"
`

export function renderWorkflow(tests: readonly GradingTestSpec[]): RenderedWorkflow {
  const ordered = [...tests]

  const manifest = {
    version: 1,
    tests: ordered.map((test, index) => ({
      id: stepIdFor(index),
      name: test.name,
      points: test.points,
    })),
  }

  // Outcomes are passed through `env:`, not interpolated into the script body.
  // This is GitHub's own recommended pattern for untrusted expression values.
  const outcomeEnv: Record<string, string> = {}
  ordered.forEach((_test, index) => {
    const id = stepIdFor(index)
    outcomeEnv[`OUTCOME_${id}`] = `\${{ steps.${id}.outcome }}`
  })

  const testSteps = ordered.flatMap((test, index) => {
    const id = stepIdFor(index)
    const commands = [test.setupCommand, test.runCommand]
      .filter((c): c is string => Boolean(c && c.trim()))
      .join('\n')

    return [
      {
        name: test.name,
        id,
        // Every test runs even if an earlier one fails: partial credit requires
        // knowing the outcome of each, not just the first failure.
        'continue-on-error': true,
        'timeout-minutes': test.timeoutMinutes,
        run: `${commands}\n`,
      },
    ]
  })

  const workflow = {
    name: 'UCF Code Classroom Autograding',
    on: {
      push: { branches: ['**'] },
      // Lets an instructor re-run grading without asking the student to push.
      workflow_dispatch: null,
    },
    // Least privilege: grading reads the code and writes nothing back. The
    // results reach the app as an artifact, so no token with write access and no
    // repository secret is needed.
    permissions: { contents: 'read' },
    concurrency: {
      // A student pushing three times in a minute should produce one meaningful
      // run, not three competing ones.
      group: 'uccc-autograding-${{ github.ref }}',
      'cancel-in-progress': true,
    },
    jobs: {
      autograde: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { name: 'Check out the submission', uses: 'actions/checkout@v4' },
          ...testSteps,
          {
            name: 'Collect results',
            // `always()` so results are produced even when tests fail, which is
            // the normal case for a partially complete submission.
            if: 'always()',
            env: {
              ...outcomeEnv,
              MANIFEST: MANIFEST_PATH,
              RESULTS: RESULTS_FILE_NAME,
            },
            run: COLLECT_SCRIPT,
          },
          {
            name: 'Upload results',
            if: 'always()',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: RESULTS_ARTIFACT_NAME,
              path: RESULTS_FILE_NAME,
              'if-no-files-found': 'error',
              // Long enough to survive a marking period, short enough not to
              // accumulate indefinitely.
              'retention-days': 90,
            },
          },
        ],
      },
    },
  }

  const header =
    '# Managed by UCF Code Classroom. Edits here are overwritten when the\n' +
    '# assignment\'s autograding tests change.\n' +
    `# Test definitions live in ${MANIFEST_PATH}.\n`

  return {
    workflowYaml: header + stringify(workflow, { lineWidth: 0 }),
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  }
}

/** Total points available, for showing a denominator before any run exists. */
export function totalPoints(tests: readonly GradingTestSpec[]): number {
  return tests.reduce((sum, test) => sum + test.points, 0)
}
