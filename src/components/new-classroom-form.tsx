'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FieldError, FieldHint, Input, Label, Select } from '@/components/ui/input'
import { createClassroom } from '@/lib/classrooms/actions'
import type { ActionResult } from '@/lib/classrooms/schemas'

type InstallationOption = {
  installationId: string
  orgLogin: string
  repositorySelection: string
  /** How many classrooms already live in this org. Informational, never a block. */
  existingClassrooms: number
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" disabled={pending}>
      {pending ? 'Creating…' : 'Create classroom'}
    </Button>
  )
}

export function NewClassroomForm({ installations }: { installations: InstallationOption[] }) {
  // The action redirects on success, so state only ever holds a failure.
  const [state, formAction] = useActionState(
    async (_prev: ActionResult<never> | null, formData: FormData) =>
      createClassroom(formData),
    null,
  )

  const fieldError = (name: string) =>
    state && !state.ok ? state.fieldErrors?.[name] : undefined

  return (
    <form action={formAction}>
      <Card>
        <CardContent className="space-y-5">
          {state && !state.ok ? (
            <p
              role="alert"
              className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2"
            >
              {state.error}
            </p>
          ) : null}

          <div>
            <Label htmlFor="installationId">GitHub organization</Label>
            <Select id="installationId" name="installationId" required defaultValue="">
              <option value="" disabled>
                Choose an organization…
              </option>
              {installations.map((i) => (
                <option key={i.installationId} value={i.installationId}>
                  {i.orgLogin}
                  {i.existingClassrooms > 0
                    ? ` — already hosts ${i.existingClassrooms} classroom${i.existingClassrooms === 1 ? '' : 's'}`
                    : ''}
                </option>
              ))}
            </Select>
            <FieldHint>
              Assignment repositories are created here. This cannot be changed later.
              {installations.some((i) => i.existingClassrooms > 0)
                ? ' Sharing an organization between classrooms is fine — a new term of the same course usually should. Give each assignment a distinct repository prefix so the names stay readable.'
                : ''}
            </FieldHint>
            {fieldError('installationId') ? (
              <FieldError>{fieldError('installationId')}</FieldError>
            ) : null}
          </div>

          <div>
            <Label htmlFor="name">Classroom name</Label>
            <Input
              id="name"
              name="name"
              required
              minLength={3}
              maxLength={200}
              placeholder="Processes for Object-Oriented Software Development"
            />
            {fieldError('name') ? <FieldError>{fieldError('name')}</FieldError> : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="courseCode">Course code</Label>
              <Input id="courseCode" name="courseCode" maxLength={30} placeholder="COP4331" />
              <FieldHint>Optional. Used in the classroom URL.</FieldHint>
              {fieldError('courseCode') ? (
                <FieldError>{fieldError('courseCode')}</FieldError>
              ) : null}
            </div>
            <div>
              <Label htmlFor="term">Term</Label>
              <Input id="term" name="term" maxLength={50} placeholder="Fall 2026" />
              <FieldHint>Optional.</FieldHint>
              {fieldError('term') ? <FieldError>{fieldError('term')}</FieldError> : null}
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-end">
          <SubmitButton />
        </CardFooter>
      </Card>
    </form>
  )
}
