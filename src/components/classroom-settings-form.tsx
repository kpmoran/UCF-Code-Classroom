'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint, Input, Label, Select } from '@/components/ui/input'
import { updateClassroom } from '@/lib/classrooms/actions'
import type { ActionResult } from '@/lib/classrooms/schemas'

type Props = {
  classroom: {
    id: string
    name: string
    courseCode: string | null
    term: string | null
    defaultRepoVisibility: 'PRIVATE' | 'PUBLIC'
    defaultStudentPermission: 'PULL' | 'PUSH' | 'MAINTAIN' | 'ADMIN'
  }
}

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  )
}

export function ClassroomSettingsForm({ classroom }: Props) {
  const [state, formAction] = useActionState(
    async (_prev: ActionResult<never> | null, formData: FormData) =>
      updateClassroom(formData),
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="classroomId" value={classroom.id} />
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {state ? (
            <p
              role="status"
              className={`text-sm rounded-md px-3 py-2 ${
                state.ok
                  ? 'bg-success-subtle text-success'
                  : 'bg-danger-subtle text-danger'
              }`}
            >
              {state.ok ? 'Settings saved.' : state.error}
            </p>
          ) : null}

          <div>
            <Label htmlFor="name">Classroom name</Label>
            <Input id="name" name="name" required defaultValue={classroom.name} maxLength={200} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="courseCode">Course code</Label>
              <Input
                id="courseCode"
                name="courseCode"
                defaultValue={classroom.courseCode ?? ''}
                maxLength={30}
              />
            </div>
            <div>
              <Label htmlFor="term">Term</Label>
              <Input id="term" name="term" defaultValue={classroom.term ?? ''} maxLength={50} />
            </div>
          </div>

          <FieldHint>
            Renaming does not change the classroom URL, so invite links already shared keep
            working.
          </FieldHint>

          <hr className="border-border" />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="defaultRepoVisibility">Default repository visibility</Label>
              <Select
                id="defaultRepoVisibility"
                name="defaultRepoVisibility"
                defaultValue={classroom.defaultRepoVisibility}
              >
                <option value="PRIVATE">Private</option>
                <option value="PUBLIC">Public</option>
              </Select>
              <FieldHint>
                Private is normally correct for coursework — public repositories let students
                see each other’s solutions.
              </FieldHint>
            </div>
            <div>
              <Label htmlFor="defaultStudentPermission">Default student access</Label>
              <Select
                id="defaultStudentPermission"
                name="defaultStudentPermission"
                defaultValue={classroom.defaultStudentPermission}
              >
                <option value="PULL">Read</option>
                <option value="PUSH">Write</option>
                <option value="MAINTAIN">Maintain</option>
                <option value="ADMIN">Admin</option>
              </Select>
              <FieldHint>
                Write is the usual choice. Admin would let students delete their own
                repository.
              </FieldHint>
            </div>
          </div>

          <FieldHint>
            These are defaults for new assignments. Existing assignments keep the settings
            they were created with.
          </FieldHint>
        </CardContent>
        <CardFooter className="flex justify-end">
          <SaveButton />
        </CardFooter>
      </Card>
    </form>
  )
}
