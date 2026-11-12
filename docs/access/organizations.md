# Organizations and the owner credential

How a classroom is bound to a GitHub organization, and whose token does the privileged work.

## One App, many organizations

Each faculty member installs the GitHub App on **their own** organization — a classroom
is bound to an organization and an installation, and the installation token is what
creates repositories there. Adding an App to an organization requires being an owner of
it, so this is not something an administrator can do on someone's behalf.

Their path is: accept a faculty invitation, install the App on their organization
granting access to **all repositories**, then create a classroom and pick it. The
install link is shown on the new-classroom page and derived from the API rather than
configured, because the App slug differs per registration and a hardcoded URL would
point colleagues at the wrong App.

**No Marketplace listing is needed.** Marketplace is for public distribution and wants a
verified publisher, a listing and review. An App set to *Any account* is installable by
anyone with the URL, which is all this needs.

### The organization picker is filtered by membership

`GET /app/installations` returns **every** installation of the App, App-wide. Offering
that list directly was fine with one user and became a multi-tenancy hole with two: a
faculty member could point a classroom at a colleague's organization, and assignments
would then generate repositories there using an installation token holding
`Administration: write`. The ownership check downstream only *warns*, so it did not stop
this.

So membership is a hard gate, enforced both in the picker and in `createClassroom` —
a filtered dropdown is not a permission check, since a form can be posted directly.
Membership is a much weaker claim than ownership, which is the point: you cannot be a
member of an organization you have nothing to do with. Ownership stays warn-not-block,
because everything except group assignments works for a plain member and blocking would
strand an instructor mid-promotion.

Organizations that have the App but that you do not belong to are **named in a count**
rather than silently dropped — otherwise someone who knows the App is installed
somewhere sees "not installed" and reasonably concludes the page is broken. An
organization whose membership could not be confirmed is excluded and reported too, since
an unverifiable membership is exactly the case the gate exists for.

### One organization can back many classrooms

It used to back only one. The rule lived in two places — the picker dropped any
organization that already hosted a classroom, and `createClassroom` refused one anyway if
the form was posted — on the stated grounds that two classrooms in one organization would
generate colliding repository names. That was not true: `dedupeRepoName` appends a numeric
suffix after checking the organization's live repository list, so collisions were already
handled before the rule existed. There is no unique index on `githubOrgId` behind it
either; the constraint that actually keeps classrooms distinct is the unique `slug`, which
is derived from course code and term.

What the rule did cost was real. It meant one organization per course, so the spring run
of the same course needed a brand-new organization, a fresh App installation, and a fresh
ownership check — and the symptom was the picker saying every organization you belong to
already has a classroom, with no way forward.

So an organization may back as many classrooms as you like. The picker names how many each
one already holds, and the form suggests giving each assignment a distinct repository
prefix, which is what actually keeps the names readable when a term's `hw1-` sits beside
the last term's.

## The organization-owner credential follows the membership

`Classroom.ownerTokenUserId` names whose stored GitHub token performs the privileged
organization work — creating teams, and adding people who are not organization members
yet. Removing an instructor used to leave it pointing at them, so a classroom went on
using the token of somebody who had just been taken off it. The credential belonged to
someone with no remaining connection to the course, and the day they disconnected GitHub,
group assignments began failing with a 401 that named no cause.

Losing `INSTRUCTOR` on a classroom — by removal or by demotion — now releases it. The
invariant is simply *the owner token belongs to an instructor of this classroom*, which is
easy to state and easy to test. It is handed to another instructor who has already
completed the owner connection where one exists, and cleared only when there is nobody,
because clearing is recoverable only by a human noticing a warning. Both outcomes are
audited as `classroom.owner_token_reassigned` or `classroom.owner_token_cleared`.

Note what revoking **faculty** status does not do. It sets `isFaculty` false, which stops
someone creating *new* classrooms — `requireFaculty` guards `/classrooms/new` and
`createClassroom`. It does not touch the classrooms they already have, because
`requireClassroomRole` goes by classroom membership and never consults `isFaculty`. To
remove someone from a classroom they already run, demote or remove them there; a site
admin can do that on any classroom without being a member.

### Connecting as organization owner

Settings has a **Connect GitHub as organization owner** control. It is worth knowing that
several error messages pointed at this control long before it existed: the `github-owner`
provider was registered and the token plumbing was complete, but nothing ever triggered
the sign-in, so the credential could only be established as a side effect of creating the
classroom and the advice named a button that was not there. Handing the credential on made
that gap load-bearing — clearing something unrecoverable would have been worse than the
bug being fixed — so the control now exists.
