import { Button } from '@/components/ui/button'
import { signOut } from '@/lib/auth/config'

export function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server'
        await signOut({ redirectTo: '/signin' })
      }}
    >
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
    </form>
  )
}
