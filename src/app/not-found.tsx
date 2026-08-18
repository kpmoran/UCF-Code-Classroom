import { SiteHeader } from '@/components/site-header'
import { ButtonLink } from '@/components/ui/button'

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-sm font-mono text-muted">404</p>
          <h1 className="text-2xl font-semibold">Not found</h1>
          <p className="text-muted text-sm">
            This page doesn’t exist, or you’re not a member of the classroom it belongs to.
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
