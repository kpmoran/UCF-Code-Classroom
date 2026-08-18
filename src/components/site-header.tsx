import Link from 'next/link'

import { SignOutButton } from '@/components/sign-out-button'
import { getCurrentUser } from '@/lib/auth/dal'

export async function SiteHeader() {
  const user = await getCurrentUser()

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden
            className="inline-block size-5 rounded bg-accent-bright shrink-0"
          />
          <span>UCF-Code-Connect</span>
        </Link>

        {user ? (
          <div className="flex items-center gap-3 text-sm min-w-0">
            <span className="text-muted truncate hidden sm:inline">
              {user.githubLogin ? `@${user.githubLogin}` : (user.name ?? user.email)}
            </span>
            <SignOutButton />
          </div>
        ) : null}
      </div>
    </header>
  )
}
