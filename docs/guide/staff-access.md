# Staff access to student repositories

Worth stating explicitly, because the app's own roles imply otherwise:
`ClassroomRole.TA` governs what someone can see in *this application*. It grants
nothing on GitHub. Provisioning adds exactly one collaborator — the student — so an
instructor can read student work only by being an organization owner, and a TA who
is a plain organization member can read none of it. The symptom is a TA reporting
that every repository 404s, which reads as a bug rather than as a permission that
was never granted.

The **Staff access** panel in an assignment's Settings tab fixes that. It creates
one org team per classroom (`<course>-<term>-staff`), puts every `INSTRUCTOR` and
`TA` in it, and grants the team `push` on every repository **in the classroom** —
across all assignments, not only the one whose page you are on, because the team is
a fact about the course rather than about one assignment. New repositories are
granted as students accept, so it only needs running again when staff change.

Grants are paced at ten a minute: one write each against the 60-a-minute budget,
so a 40-repository course finishes in about four minutes. Deliberately not the two
a minute the board backfill uses — that number was set when the budget was six a
minute and a board cost two writes, and reusing it here turned four minutes of work
into twenty.

A team rather than direct collaborators, for two reasons that both worsen with
class size: granting a team is one write per repository regardless of how many staff
there are, where collaborators is staff × repositories against the same
content-creation budget as provisioning; and a TA joining in week six is added to
the team once instead of to every repository that already exists. Revoking is one
team removal rather than forty.

## When a staff member also has a repository

Accepting an assignment needs a claimed roster entry and any classroom role, not
the `STUDENT` role specifically, so a TA can hold a real `AssignmentRepo` — by
accepting before being promoted, or by claiming a roster entry as staff.

That collides with deadline locking, and the collision is silent. Locking works by
lowering that person's **direct collaborator** permission to `pull`, while GitHub
resolves access to the *highest* level across every source of grant — repository,
team, organization. A staff team granting `push` therefore overrides the lock: the
row would read `locked` while its owner kept pushing, and nothing would look wrong.

So `grantStaffRepoAccess` keeps the team off any repository whose participants
include a member of that classroom's staff, and revokes an existing grant rather
than only declining to add one, so re-running repairs a repository granted before
this was understood. For group assignments one staff member anywhere in the team is
enough, since the repository is shared.

The cost is that other staff cannot reach that one repository through the team. That
is the better trade: an instructor is an organization owner and can read it anyway,
and a lock that silently does not hold is worse than a repository that needs opening
another way. `staffTeamMustAvoidRepo` holds the rule and its unit tests hold the
cases.

TAs are included in project-board sharing too (`WRITER`; instructors get `ADMIN`).
That asked for `INSTRUCTOR` only at first, which meant a TA got 404 on every board —
boards are private and an organization owner is not automatically a collaborator on
them, so the symptom was identical to the board not existing.

Two failure modes the panel reports rather than hides. Creating an org team needs
the **organization-owner credential**, not the App's own token — the same
constraint group assignments hit — and a staff member with **no linked GitHub
account** cannot be added to anything, which is the reason a TA can still see
nothing after the button reports success.
