import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'

/** Rendered when the data access layer calls `forbidden()` — HTTP 403. */
export default function Forbidden() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-sm font-mono text-muted">403</p>
          <h1 className="text-2xl font-semibold">You don’t have access to this page</h1>
          <p className="text-muted text-sm">
            You’re signed in, but this page needs a higher role in the classroom — usually
            instructor or TA. Ask your instructor if you think this is wrong.
          </p>
          <div className="pt-2">
            <ButtonLink href="/" variant="outline">
              Back to classrooms
            </ButtonLink>
          </div>
        </div>
      </main>
    </>
  )
}
