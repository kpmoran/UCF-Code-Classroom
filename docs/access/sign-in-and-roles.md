# Sign-in, faculty and site admins

Who gets in, who can create classrooms, and what a site admin can and cannot see.

## Who can create classrooms

Signing in with GitHub proves only that someone has a GitHub account, and every
student has one. So it cannot be what decides who may create a classroom — before
this gate existed, any student who found `/classrooms/new` could create one and become
its instructor.

Three levels:

| | Can join a classroom | Can create classrooms | Can invite faculty |
|---|---|---|---|
| Anyone signed in | ✅ via a roster invite link | — | — |
| Faculty | ✅ | ✅ | — |
| Site admin | ✅ | ✅ | ✅ |

## Signing in is open, deliberately

Anyone with a GitHub account can sign in. That is a decision, not an oversight, and it
is the same thing GitHub Classroom does.

Signing in grants nothing. Measured against a signed-in account with no invitation:

| | |
|---|---|
| Dashboard | 200 — empty, with guidance on how to get access |
| `/classrooms/new`, `/admin/faculty` | **403** |
| Any classroom, roster, gradebook, assignment | **404** |

Note the 404 rather than 403: a stranger cannot even confirm a classroom exists. The
only trace of them is one `users` row with no memberships.

It has to work this way, because students sign in *before* they claim a roster entry —
that is the registration flow. Requiring an invitation to sign in at all would mean a
student who signs in before opening the link hits a dead end, which is support load in
week one for no gain, given that a bare account can reach nothing.

**The classroom invite link is the real boundary**, and it is worth knowing what it is
not: anyone signed in who has the URL can open the join page and claim an unclaimed
roster entry. Possessing the link is the check. That is also GitHub Classroom's model,
and it means a forwarded link could let an outsider claim a student's identity and
repository.

Judged acceptable here because the link is shared only inside a course, every claim is
recorded in the audit log, and an instructor can unlink a mis-claimed entry from the
roster page, which frees it to be claimed again. If that trade stops being acceptable —
a larger course, a link that leaked — the fix is per-student claim codes, mail-merged
from the roster, so the link alone is not enough.

**Site admins come from configuration, not the database.** `SITE_ADMIN_LOGINS` is a
comma-separated list of GitHub logins, read on every request:

```
SITE_ADMIN_LOGINS="kpmoran"
```

That solves the bootstrap. A fresh deployment has no users, so nobody could otherwise
grant the first one anything — and the alternative, "the first account to sign in
becomes admin", is a race anyone who finds the URL before you can enter. It also means
revoking an admin is a config change and a restart rather than a database edit, with
no stale row to miss.

**Faculty come from invitations.** A site admin creates one at `/admin/faculty` and
sends the link. It is bounded like the student invite links, because it is a privilege
escalation if it leaks: single-use by default, always expiring, revocable, and every
redemption recorded against the account that used it.

Two decisions worth knowing:

- **Redeeming needs a button press, not just opening the link.** Mail clients, Slack
  unfurls and security proxies all follow URLs, and any of them would otherwise consume
  a single-use invitation before the recipient clicked anything. The landing page is
  read-only; accepting is a POST.
- **Every rejection shows the same message.** Distinguishing "no such invitation" from
  "already used up" would confirm to someone guessing tokens that a particular one is
  real.

Withdrawing someone's faculty access does not touch the classrooms they already run —
they remain an instructor there. Removing someone mid-semester from courses full of
student work is a much larger decision than "should they be able to start new ones".

The migration that adds this grants faculty to everyone already recorded as an
INSTRUCTOR of a classroom, so introducing the gate cannot lock out the people already
teaching here — but note the gap: someone who had signed in and *not yet created a
classroom* is not covered, which includes whoever just deployed it.

## If you have locked yourself out

Symptom: you sign in, and there is no "New classroom" button and no "Faculty access".
It means neither route to faculty applied — `SITE_ADMIN_LOGINS` is not reaching the
container, and you had no classroom for the migration to grandfather.

Check the configuration actually arrived, which is the usual cause. Appending to
`.env` with `>>` when the file has no trailing newline silently joins the new setting
onto the previous line, and both are then lost:

```bash
cd /opt/uccc
tail -3 .env                                              # is the line intact and on its own?
docker compose exec -T app sh -c 'echo "[$SITE_ADMIN_LOGINS]"'   # did it reach the container?
```

To get straight back in, set the flags directly — the column is checked as well as the
configuration:

```bash
docker compose exec -T postgres psql -U uccc -d uccc \
  -c 'update users set "isFaculty" = true, "isSiteAdmin" = true where "githubLogin" = '"'"'your-login'"'"';'
```

Then fix `SITE_ADMIN_LOGINS` properly, because it is what survives a database restore.

## What a site admin can see

Site admins have always been able to reach any classroom by URL — `requireClassroomRole`
grants them `INSTRUCTOR` when they are not a member, as a break-glass path for support and
for recovering a classroom whose instructor left. Nothing listed those classrooms though,
so operating the server meant guessing a slug from a course code and term, or reading the
database. `/admin/classrooms` lists them.

The listing is metadata only: name, term, organization, who teaches it, roster and
assignment counts, archived state, and a warning where a classroom has **no instructor
left** — which is the state it is most useful for finding.

Reaching a classroom's configuration and reading its students are now separate questions,
because running an instance is a reason for the first and not the second:

| | Non-member site admin |
|---|---|
| `/admin/classrooms`, classroom overview, settings | allowed |
| roster, grades, per-assignment table, activity log | **403** |

`requireEnrolledStaff` and `requireEnrolledInstructor` are the guards; they take the role
requirement and the membership requirement as independent conditions, which matters
because the activity log needs both — it names students alongside actions taken on them,
so it is not for TAs either.

The way in is **Join** on the listing, which adds the admin as an instructor and writes
`classroom.admin_joined` to that classroom's activity log. So the capability is unchanged
in substance — an admin can still get to anything — but it now costs one deliberate click
and leaves a record naming who did it, instead of being ambient and invisible.

Faculty see nothing new: `/admin/classrooms` is `requireSiteAdmin`, and another
instructor's classroom still returns 404 to them rather than 403, so slugs stay
unenumerable.
