/**
 * Shown the instant "New assignment" is clicked.
 *
 * Without this, a client-side navigation leaves the *previous* page on screen for
 * the whole time the server is working, with nothing anywhere to say a click
 * registered — so any delay reads as a broken button rather than as loading, and
 * the natural response is to click it again.
 *
 * Deliberately static: no session lookup, no database, and in particular not
 * `SiteHeader`, which is async. A fallback that has to await something can hardly
 * be the thing that appears immediately.
 */
function Bar({ className = '' }: { className?: string }) {
  return <div className={`rounded bg-surface-subtle ${className}`} />
}

export default function NewAssignmentLoading() {
  return (
    <>
      {/* Stands in for the header at the same height, so the content below does
          not jump downward when the real one arrives. */}
      <div className="border-b border-border bg-surface h-14" />

      <main className="flex-1 mx-auto w-full max-w-2xl px-6 py-8" aria-busy="true">
        <p className="sr-only" role="status">
          Loading the new assignment form
        </p>

        <div className="mb-6">
          <Bar className="h-4 w-40" />
          <Bar className="h-7 w-56 mt-3" />
          <Bar className="h-4 w-full max-w-md mt-3" />
        </div>

        {/* Three cards, matching the form's own shape: details, template, options. */}
        <div className="space-y-6">
          {[0, 1, 2].map((card) => (
            <div key={card} className="rounded-lg border border-border bg-surface p-5">
              <Bar className="h-5 w-40" />
              <div className="mt-5 space-y-4">
                <div>
                  <Bar className="h-4 w-24" />
                  <Bar className="h-9 w-full mt-2" />
                </div>
                <div>
                  <Bar className="h-4 w-32" />
                  <Bar className="h-9 w-full mt-2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  )
}
