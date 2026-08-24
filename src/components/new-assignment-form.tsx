'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { TemplateCombobox } from '@/components/template-combobox'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldError, FieldHint, Input, Label, Select } from '@/components/ui/input'
import { createAssignment, getTemplateSuggestions } from '@/lib/assignments/actions'
import type { AssignmentActionResult } from '@/lib/assignments/schemas'
import { slugify } from '@/lib/slug'

type Props = {
  classroomId: string
  orgLogin: string
  defaultVisibility: 'PRIVATE' | 'PUBLIC'
  defaultStudentPermission: 'PULL' | 'PUSH' | 'MAINTAIN' | 'ADMIN'
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" disabled={pending}>
      {pending ? 'Creating…' : label}
    </Button>
  )
}

export function NewAssignmentForm({
  classroomId,
  orgLogin,
  defaultVisibility,
  defaultStudentPermission,
}: Props) {
  const [type, setType] = useState<'INDIVIDUAL' | 'GROUP'>('INDIVIDUAL')
  const [title, setTitle] = useState('')
  const [prefixEdited, setPrefixEdited] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [publish, setPublish] = useState(true)

  const [state, formAction] = useActionState(
    async (_prev: AssignmentActionResult<never> | null, formData: FormData) =>
      createAssignment(formData),
    null,
  )

  const fieldError = (name: string) =>
    state && !state.ok ? state.fieldErrors?.[name] : undefined

  // Derive the prefix from the title until the instructor types their own, then
  // leave it alone — it appears in every student repository name.
  function onTitleChange(value: string) {
    setTitle(value)
    if (!prefixEdited) setPrefix(slugify(value).slice(0, 40))
  }

  const samplePrefix = prefix || 'assignment'

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="classroomId" value={classroomId} />
      <input type="hidden" name="type" value={type} />
      {publish ? <input type="hidden" name="publish" value="on" /> : null}

      {state && !state.ok ? (
        <p role="alert" className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2">
          {state.error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              required
              minLength={3}
              maxLength={200}
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Homework 1 — Unit Testing"
            />
            {fieldError('title') ? <FieldError>{fieldError('title')}</FieldError> : null}
          </div>

          <fieldset>
            <legend className="text-sm font-medium mb-1.5">Assignment type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['INDIVIDUAL', 'Individual', 'One repository per student.'],
                  ['GROUP', 'Group', 'One repository per team, via a GitHub team.'],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`flex gap-2 items-start rounded-md border px-3 py-2.5 cursor-pointer text-sm ${
                    type === value ? 'border-accent bg-surface-subtle' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="typeChoice"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Starting point</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="template">Template (optional)</Label>
            <TemplateCombobox
              id="template"
              name="template"
              orgLogin={orgLogin}
              loadTemplates={() => getTemplateSuggestions(classroomId)}
            />
            {fieldError('template') ? <FieldError>{fieldError('template')}</FieldError> : null}
          </div>

          <div>
            <Label htmlFor="repoPrefix">Repository name prefix</Label>
            <Input
              id="repoPrefix"
              name="repoPrefix"
              required
              maxLength={60}
              value={prefix}
              onChange={(e) => {
                setPrefixEdited(true)
                setPrefix(e.target.value)
              }}
              placeholder="hw1"
            />
            <FieldHint>
              Repositories will be named like{' '}
              <span className="font-mono">
                {samplePrefix}-{type === 'GROUP' ? 'team-name' : 'github-username'}
              </span>
              . This cannot be changed once repositories exist.
            </FieldHint>
            {fieldError('repoPrefix') ? <FieldError>{fieldError('repoPrefix')}</FieldError> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Access and deadline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="visibility">Repository visibility</Label>
              <Select id="visibility" name="visibility" defaultValue={defaultVisibility}>
                <option value="PRIVATE">Private</option>
                <option value="PUBLIC">Public</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="studentPermission">Student access</Label>
              <Select
                id="studentPermission"
                name="studentPermission"
                defaultValue={defaultStudentPermission}
              >
                <option value="PULL">Read</option>
                <option value="PUSH">Write</option>
                <option value="MAINTAIN">Maintain</option>
                <option value="ADMIN">Admin</option>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="deadline">Deadline</Label>
            <Input id="deadline" name="deadline" type="datetime-local" />
            <FieldHint>Optional. Interpreted in this server’s time zone.</FieldHint>
            {fieldError('deadline') ? <FieldError>{fieldError('deadline')}</FieldError> : null}
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" name="lockOnDeadline" className="mt-0.5" />
            <span>
              Revoke write access at the deadline
              <span className="block text-xs text-muted">
                Students keep read access. Granting an extension restores it.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {type === 'GROUP' ? (
        <Card>
          <CardHeader>
            <CardTitle>Teams</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="maxTeams">Maximum teams</Label>
              <Input id="maxTeams" name="maxTeams" type="number" min={1} max={500} />
              <FieldHint>Optional.</FieldHint>
            </div>
            <div>
              <Label htmlFor="maxTeamSize">Maximum team size</Label>
              <Input id="maxTeamSize" name="maxTeamSize" type="number" min={1} max={50} />
              <FieldHint>Optional.</FieldHint>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Extras</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" name="feedbackPrEnabled" className="mt-0.5" />
            <span>
              Open a feedback pull request
              <span className="block text-xs text-muted">
                A “Feedback” PR pinned to the starting state, so its diff always shows the
                student’s whole submission and you can comment line by line.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" name="autogradeEnabled" className="mt-0.5" />
            <span>
              Enable autograding
              <span className="block text-xs text-muted">
                Adds a GitHub Actions workflow that runs your tests on every push. Configure
                the tests after creating the assignment.
              </span>
            </span>
          </label>

          <hr className="border-border" />

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Publish immediately
              <span className="block text-xs text-muted">
                Unpublished assignments are visible only to you and your TAs.
              </span>
            </span>
          </label>
        </CardContent>
        <CardFooter className="flex justify-end">
          <SubmitButton label={publish ? 'Create and publish' : 'Create as draft'} />
        </CardFooter>
      </Card>
    </form>
  )
}
