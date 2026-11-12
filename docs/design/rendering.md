# Pages do not wait on GitHub

The new-assignment form fetched the organization's template repositories while
rendering. That made it about **fifty times** slower to respond than the classroom page
it is reached from — 280ms against 5ms locally, on an organization holding two
repositories. Because "New assignment" is a client-side navigation with no fallback to
show, the browser kept displaying the *previous* page for the whole wait, so the click
looked ignored rather than slow, and the natural response was to click it again.

The suggestions were never load-bearing. The template field accepts any `owner/repo` as
free text and validates it on submit, so the form is completely usable before the list
exists. It is now fetched by the combobox after it mounts, via the
`getTemplateSuggestions` action, which authorizes exactly as the create action does —
the list contains private repository names and must not be readable by anyone who could
not already create the assignment.

Two details worth keeping:

* The list loads **into state**, not through a Suspense boundary. Suspense would replace
  the input with a fresh one when the data landed and take any half-typed value with it —
  the same failure as an uncontrolled field being reset by a form action, but landing
  mid-word. Keeping one mounted instance is what makes `typing survives the suggestions
  arriving` pass.
* There is deliberately **no `loading.tsx`** on these routes, and that is worth knowing
  before adding one. A route-level loading file makes Next flush that shell — with a
  **200** — before the page component runs, so a `forbidden()` inside the page can no
  longer set the status. The body is still correct (a student sees the forbidden page and
  no settings), but the status lies, and anything reading the status rather than the body
  is told the request succeeded. It was measured: with a `loading.tsx`, `/settings` and
  `/assignments/new` returned 200 to a student while `/roster`, which had none, correctly
  returned 403. The skeleton was worth about five milliseconds of cosmetics once the
  blocking calls were gone, so it lost. `a student cannot reach instructor settings` now
  asserts the status on both routes.

`listTemplateRepos` also stopped paginating the whole organization. It asks the search
API for `org:<org> template:true`, which is one request instead of one per hundred
repositories — and a classroom organization gains a repository per student per
assignment, so the old cost grew every time the app was used. Verified against a real
installation: search does return **private** templates to an installation token, which
is the case that matters, since course templates usually are. Search is a separate index
with its own rate limit and can lag repository creation by a few seconds, so the
exhaustive listing remains as a fallback and the field still takes free text.

**Classroom settings** had the same shape and is fixed the same way, except that there the
answer is streamed rather than fetched by the client. The live ownership check decides
which of two badges to show, and used to run before the page replied — delaying the
settings form, the invite panel and the archive controls, none of which depend on it. The
card now renders immediately with the organization name, which the database already knows,
and the badge arrives over the stream: **~16ms to first byte against ~200–270ms**, with
the badge landing about 150ms later.

Note that Suspense is right there and was wrong for the template picker. The deciding
question is whether the subtree holds state a person owns: replacing a badge when the data
lands costs nothing, whereas re-mounting a text field discards what was being typed. Same
mechanism, opposite conclusion.
