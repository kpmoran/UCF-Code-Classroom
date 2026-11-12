# Project boards

Two GitHub rules govern this, and each one on its own is misleading.

**Repository-level boards are gone.** GitHub sunset them on 23 August 2024; the classic
REST API followed on 1 April 2025, which is why those endpoints answer 404 rather than
403. A board is owned by an account and *linked* to a repository afterwards.

**Linking is ownership-bound.** [GitHub's documentation][link-doc] is explicit: "You can
only list projects that are owned by the same user or organization that owns the
repository." Assignment repositories belong to the classroom's organization, so a board
on a student's personal account can *never* be attached to one. Only a board owned by
that organization can be.

The student-facing copy says exactly that, because the obvious-sounding advice — "make a
board and link your repository to it" — is a dead end that looks like it should work. An
earlier version of this page gave that advice; it was wrong.

## Creating them automatically

Tick **Create a project board for each student** when creating an assignment, and
provisioning makes one board per student (or per team) owned by the organization and
linked to their repository — `createProjectV2` takes a `repositoryId`, so creating and
linking is a single mutation rather than two.

It needs one thing that is not on by default:

> **Projects: write** on the GitHub App — and, like every permission change, each
> organization must *accept* it before it takes effect. Until then the option is
> harmless: provisioning succeeds, the repository works, and the assignment records
> "The GitHub App is not allowed to create project boards…" against the affected rows
> rather than failing.

The board URL is stored on the row, so a retried job links the board that exists rather
than creating a second one — GitHub will happily create any number of identically titled
projects.

## Adding boards to an assignment already under way

Provisioning only creates a board when a student accepts, which would mean switching the
setting on applied to nobody who had already started — and by the time anyone decides
they want boards, that is usually everyone. So the assignment page has a **Project
boards** panel that switches the setting and backfills in one action, with three counts:
repositories that have a board, ones that are ready and do not, and ones with no
repository yet. Only the middle column needs anything from you; the last is handled by
provisioning when those repositories appear.

## A board nobody can open

Creating a board is only half of it. A Projects v2 board owned by an organization is
private, and one created through an installation token has the **App as its only
collaborator** — so until people are added, every human gets a 404, including the
organization's owners. GitHub answers 404 rather than 403 for anything you cannot see,
which makes a board that exists look like one that was never created.

So the job grants access as a second step: the student (or every member of the team)
as **WRITER**, and the classroom's instructors as **ADMIN**. Students get WRITER rather
than ADMIN deliberately — enough to add, move and close items, not enough to delete the
board or change who can see it.

Both steps are idempotent, and the panel's button stays available even when no board is
missing, labelled **Repair board access**. That is not decoration: it is the only way to
fix boards created before this step existed, which are indistinguishable from missing
ones until you look in the database.

Turning boards *off* leaves existing ones alone. They may already hold a student's
planning, and deleting that to honour a checkbox would be the wrong reading of it.

Students can also keep boards on their own accounts for personal planning, which is what
the link on their assignment page offers; `github.com/projects` is a 404, so it has to
carry their login.

[link-doc]: https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/adding-your-project-to-a-repository

Nothing here provisions boards. Doing so would need a `Projects: write` permission on the
GitHub App, which every installed organization has to accept before it takes effect, plus
GraphQL calls competing for the same rate budget as repository creation — a real cost for
something a student can do in two clicks.
