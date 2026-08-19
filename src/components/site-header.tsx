import Image from 'next/image'
import Link from 'next/link'

import { SignOutButton } from '@/components/sign-out-button'
import { ThemeToggle } from '@/components/theme-toggle'
import { getCurrentUser } from '@/lib/auth/dal'

export async function SiteHeader() {
  const user = await getCurrentUser()

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          {/*
           * Decorative: the adjacent text already names the site, so an alt here
           * would just make screen readers say it twice.
           *
           * `dark:invert` turns the black mark white, which is UCF's own reversed
           * treatment — the artwork is solid black on transparency, so inverting
           * is exact rather than an approximation. Sized in CSS as well as via
           * width/height so the row cannot shift while the image loads.
           */}
          <Image
            src="/ucf-pegasus.png"
            alt=""
            aria-hidden
            width={192}
            height={192}
            priority
            className="size-6 shrink-0 dark:invert"
          />
          <span>UCF-Code-Connect</span>
        </Link>

        <div className="flex items-center gap-3 text-sm min-w-0">
          <ThemeToggle />
          {user ? (
            <>
              <span className="text-muted truncate hidden sm:inline">
                {user.githubLogin ? `@${user.githubLogin}` : (user.name ?? user.email)}
              </span>
              <SignOutButton />
            </>
          ) : null}
        </div>
      </div>
    </header>
  )
}
