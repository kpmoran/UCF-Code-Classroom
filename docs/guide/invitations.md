# Invitations and organization membership

## Invitations, and knowing when they are accepted

Adding a student to a repository they cannot already see produces a GitHub *invitation*,
and the app records its id. Accepting happens entirely on GitHub, which tells the app
nothing — the App subscribes to no event that would say so — so the row kept its
invitation id forever and both pages went on saying "Accept your GitHub invitation" to
students who already had.

The fix asks GitHub rather than waiting to be told, in two places:

* A student's own assignment page reconciles **their** invitation when one is
  outstanding. One read, and only while it is genuinely outstanding: once cleared it
  never runs again for that repository.
* The instructor's panel offers **Re-check N invitations** when any are outstanding,
  so a whole assignment can be brought up to date without waiting for students to visit.

It asks whether the student is a *collaborator*, not whether the invitation is still
listed. The two differ in the case that matters: a declined or expired invitation also
vanishes from the pending list, and reading that as acceptance would replace a wrong
"please accept" with a wrong "all good". Reads only, so none of this competes with the
content-creating rate budget.

Note that a student who is already a member of the organization never gets an invitation
at all — they are added directly, and their row has no invitation id from the start.
That observation is what the next section builds on.

### Resending

GitHub expires an invitation after seven days and never re-sends it, and re-adding a
student whose invitation is still pending neither re-sends the email nor extends it. So a
resend cancels the old invitation and issues a new one. Instructors can resend one or
all of an assignment's outstanding invitations; a student can send themselves a new one
from their own assignment page, rate-limited to one per fifteen minutes.

On a group assignment the invitation is the organization's, carried by the team, and
GitHub returns no id for it when the team membership is created. The resend finds it by
login in the organization's pending list, cancels it, and adds the student to the team
again — which sends a fresh one.

## Students as organization members

Every per-repository invitation is a chance to miss one, and students did: by the third
assignment of a term, several were locked out of their own repository at the deadline
because an email from a week earlier had gone unread. The resend path above is the
remedy; this is the prevention.

A classroom with **Students in the organization** switched on (it is on for new
classrooms, off for ones that predate it) invites each student to the organization at
the moment they claim their roster entry — one invitation, at the one time they are
already dealing with the classroom. The invitation goes through a per-classroom team
named like the staff team (`COP3502-Spring 2027-students`) so that an organization
hosting several courses can tell them apart. That team holds membership only and is never
granted a repository: deadline locking lowers a student's *direct* permission, and a
team grant would outrank it.

Once a student is a member, `addCollaborator` grants each assignment repository directly
with no invitation — the provisioning code did not change. A student who accepts an
assignment before accepting the organization invitation still gets a repository
invitation, and the moment they become a member the app replaces it with direct access.

The organization's base repository permission must be **No permission**, and the app
refuses to invite anyone while it is not: anything higher would let every student read
every classmate's repository, and at *Write* or above deadline locks would stop holding,
because GitHub grants the highest permission from any source. The settings page shows
the live check.

The people page shows where each student stands — not invited, invited, expired, failed,
member — with a resend for any of them, and the student's classroom page tells them when
their own invitation is waiting or has run out, with a button to request another.

At the end of a term, the settings page can take the classroom's students out of the
organization, either converting them to outside collaborators (they keep their own
repositories) or removing them outright. It only ever removes someone this classroom made
a member: a student who was already in the organization, an organization owner, staff of
another classroom there, or a student still enrolled in another active classroom that
grants membership, is left alone, and the reason is recorded on their row. A student
removed from a classroom mid-term leaves the organization with it, under the same rules.
