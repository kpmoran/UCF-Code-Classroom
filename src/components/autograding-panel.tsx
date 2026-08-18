'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Input, Label } from '@/components/ui/input'
import {
  resyncAssignmentGrades,
  saveGradingTests,
} from '@/lib/autograding/actions'

export type TestDraft = {
  name: string
  setupCommand: string
  runCommand: string
  timeoutMinutes: number
  points: number
}

/**
 * Autograding configuration.
 *
 * Tests are edited as a whole list and saved together: their order and point total
 * only make sense as a set, and a partial save could leave an assignment whose
 * points do not add up to what students were told.
 */
export function AutogradingPanel({
  assignmentId,
  enabled,
  initialTests,
  repoCount,
}: {
  assignmentId: string
  enabled: boolean
  initialTests: TestDraft[]
  repoCount: number
}) {
  const router = useRouter()
  const [autograde, setAutograde] = useState(enabled)
  const [tests, setTests] = useState<TestDraft[]>(initialTests)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const totalPoints = tests.reduce((sum, t) => sum + (Number(t.points) || 0), 0)

  function update(index: number, patch: Partial<TestDraft>) {
    setTests((current) =>
      current.map((test, i) => (i === index ? { ...test, ...patch } : test)),
    )
  }

  function addTest() {
    setTests((current) => [
      ...current,
      { name: '', setupCommand: '', runCommand: '', timeoutMinutes: 10, points: 10 },
    ])
  }

  function removeTest(index: number) {
    setTests((current) => current.filter((_, i) => i !== index))
  }

  function move(index: number, direction: -1 | 1) {
    setTests((current) => {
      const next = [...current]
      const target = index + direction
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function save() {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      fd.set('tests', JSON.stringify(tests))
      if (autograde) fd.set('autogradeEnabled', 'on')

      const result = await saveGradingTests(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage(
        result.data.injected > 0
          ? `Saved. The workflow was updated in ${result.data.injected} repositor${
              result.data.injected === 1 ? 'y' : 'ies'
            }.`
          : 'Saved.',
      )
      router.refresh()
    })
  }

  function resync() {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('assignmentId', assignmentId)
      const result = await resyncAssignmentGrades(fd)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage(
        result.data.queued === 0
          ? `Checked ${result.data.repos} repositories — every completed run is already graded.`
          : `Queued ${result.data.queued} run${result.data.queued === 1 ? '' : 's'} for grading.`,
      )
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Autograding</CardTitle>
            <CardDescription>
              Runs your tests in GitHub Actions on every push and records a score.
            </CardDescription>
          </div>
          <Badge tone={autograde ? 'success' : 'neutral'}>
            {autograde ? `${totalPoints} points` : 'disabled'}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm rounded-md bg-success-subtle text-success px-3 py-2">
            {message}
          </p>
        ) : null}

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autograde}
            onChange={(e) => setAutograde(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Enable autograding
            <span className="block text-xs text-muted">
              Adds a workflow and a test manifest to each repository. The workflow needs no
              secrets — results come back as a build artifact.
            </span>
          </span>
        </label>

        {autograde ? (
          <>
            {tests.length === 0 ? (
              <p className="text-sm text-muted">
                No tests configured yet. Add one below — a test is a shell command whose exit
                status decides whether its points are awarded.
              </p>
            ) : (
              <ul className="space-y-3">
                {tests.map((test, index) => (
                  <li key={index} className="rounded-md border border-border p-3 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted font-mono mt-2">#{index + 1}</span>
                      <div className="flex-1 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <Label htmlFor={`name-${index}`}>Test name</Label>
                            <Input
                              id={`name-${index}`}
                              value={test.name}
                              onChange={(e) => update(index, { name: e.target.value })}
                              maxLength={200}
                              placeholder="Unit tests"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label htmlFor={`points-${index}`}>Points</Label>
                              <Input
                                id={`points-${index}`}
                                type="number"
                                min={0}
                                max={10000}
                                value={test.points}
                                onChange={(e) =>
                                  update(index, { points: Number(e.target.value) })
                                }
                              />
                            </div>
                            <div>
                              <Label htmlFor={`timeout-${index}`}>Timeout (min)</Label>
                              <Input
                                id={`timeout-${index}`}
                                type="number"
                                min={1}
                                max={60}
                                value={test.timeoutMinutes}
                                onChange={(e) =>
                                  update(index, { timeoutMinutes: Number(e.target.value) })
                                }
                              />
                            </div>
                          </div>
                        </div>

                        <div>
                          <Label htmlFor={`setup-${index}`}>Setup command</Label>
                          <Input
                            id={`setup-${index}`}
                            value={test.setupCommand}
                            onChange={(e) => update(index, { setupCommand: e.target.value })}
                            className="font-mono text-xs"
                            placeholder="npm ci"
                          />
                          <FieldHint>Optional. Runs before the test command.</FieldHint>
                        </div>

                        <div>
                          <Label htmlFor={`run-${index}`}>Test command</Label>
                          <Input
                            id={`run-${index}`}
                            value={test.runCommand}
                            onChange={(e) => update(index, { runCommand: e.target.value })}
                            className="font-mono text-xs"
                            placeholder="npm test"
                          />
                          <FieldHint>
                            Points are awarded when this exits zero.
                          </FieldHint>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Move test ${index + 1} up`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Move test ${index + 1} down`}
                          disabled={index === tests.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove test ${index + 1}`}
                          onClick={() => removeTest(index)}
                        >
                          ✕
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <Button type="button" variant="outline" size="sm" onClick={addTest}>
              Add a test
            </Button>

            {repoCount > 0 ? (
              <p className="text-xs text-muted">
                Saving rewrites the workflow in {repoCount} existing repositor
                {repoCount === 1 ? 'y' : 'ies'}, so students are graded against the current
                tests.
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>

      <CardFooter className="flex justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || !autograde}
          onClick={resync}
          title="Re-read completed workflow runs from GitHub, for grades missed by a webhook"
        >
          Re-sync grades
        </Button>
        <Button variant="accent" disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save autograding'}
        </Button>
      </CardFooter>
    </Card>
  )
}
