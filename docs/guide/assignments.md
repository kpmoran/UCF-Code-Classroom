# Assignments and repositories

Assignments without a template, and assignments whose repositories already exist.

## Assignments without a template

The template is optional. Leave it blank and every student gets an **empty** repository
to push into — `auto_init` is false, so there is genuinely no commit, no default branch
and no README nobody asked for. "Build this from scratch" is an ordinary assignment to
set, so blank is a choice rather than a missing value, and the field says so in each of
its states.

Both `templateOwner` and `templateRepo` are nullable and move together; there is no
meaningful state where a repository name exists without an owner. The provisioning jobs
branch on their presence, and the empty path skips the wait for GitHub's asynchronous
template copy — waiting for content that will never arrive would burn the whole timeout
and fail the job.

An empty repository is a different state on GitHub than an empty *template*, which is
what caught a real bug here. Two behaviours were verified against a live installation
rather than assumed:

* Writing the autograding workflow **works**, through the contents API, and becomes the
  repository's first commits along with its `main` branch.
* Opening the feedback pull request **skips** with "the repository has no commits yet"
  and opens by itself once the student pushes — but only after a fix. The git refs
  endpoint answers `409 Git Repository is empty` where the rest of the API answers `404`,
  and `getRef` only treated 404 as absence, so the job threw instead of skipping. Both
  `getRef` and `getRepoHead` now treat 409 the same as 404, since to every caller they
  mean the same thing.

The deadline snapshot already recorded an empty SHA for a repository with no commits, so
that path needed nothing.

## Repositories that already exist

Both assignment types normally create repositories — one per student, or one per
team. A semester-long project often does not work that way: the repositories exist
before the assignment does, seeded by hand or carried over from an earlier phase, and
creating a second empty set is not useful.

Set **Repositories → Use repositories that exist** when creating the assignment
(`repoSource` is `EXISTING`; `CREATE` is the default and the original behaviour).
Then:

* **Group** — create the teams, add members, and link each team to its repository from
  the Teams panel.
* **Individual** — assign each student their repository from the assignment's
  Repositories tab. Students cannot accept this kind of assignment themselves: which
  repository they belong in is not something they can know, so the button is replaced
  by a line saying their instructor assigns it. Bulk provisioning is refused for the
  same reason.

Either way the reference is read by the same parser the template field uses:
`owner/name`, a bare name, or a pasted GitHub URL.

Only the create-the-repository step of each provisioning job changes. Access, the
GitHub team, the autograding workflow, the feedback baseline, staff access, project
boards, deadline snapshots and locking are all the same code, because every one of
them already worked from an `owner/name` rather than from something it had just made.

Three things are deliberately *not* done to a repository that was adopted:

* **It is never created.** If the linked repository is missing at provisioning time the
  job fails and says so. Falling back to creating one is the failure this mode exists
  to avoid — a repository conjured out of a typo looks provisioned, collects the
  workflow and the collaborators, and is empty at the deadline.
* **Its visibility is left alone.** Under `CREATE` the assignment's visibility setting
  describes a repository this app is making; here it describes one that already has a
  history and an audience, and flipping a public project private is not a side effect
  to bury in a job. The form says the setting does not apply.
* **A previous link is not torn down.** Relinking or reassigning leaves access to the
  old repository intact, for the same reason moving a student between teams does:
  cutting people off from work they have already committed is a decision to make
  deliberately, not a side effect of fixing a typo.

Repositories must be in the classroom's organization. This is a limit rather than a
policy — access is granted through the classroom's installation, and the workflow,
feedback branch and deadline lock are written with its token — so a repository in a
personal account is refused at link time with that reason, instead of linking and then
failing every subsequent GitHub write. That rule and the duplicate check live in
`canAdoptRepo` (`src/lib/repos/adopt.ts`), pure and unit-tested, and shared by both
assignment types.

Team formation stays silent until a repository is linked: `ensureTeamProvisioning`
does not queue a job for an `EXISTING` team that has none, because the job could only
fail, and would fail again on every join and every move. Once the link exists the
ordinary path resumes, which is what keeps the late-joiner case working.

### Several students, one repository

On an individual assignment, more than one student may be assigned the **same**
repository — a shared course project, or a codebase a group works in while being
graded individually. Each student keeps their own `assignment_repos` row, so
collaborator access, extensions, the deadline lock and grades all stay per-student;
the rows simply share a `fullName` and a `githubRepoId`. The panel shows a *shared
with n* badge while assigning, so this is visible at the time rather than discovered
when two students turn out to have identical grades.

Group assignments deliberately do **not** allow this: two teams pointing at one
repository is almost always a paste into the wrong row, and its consequences are quiet
— both teams get push access, the feedback pull request and the deadline snapshot
belong to whichever row ran last, and one team ends up graded on the other's work. So
the team path passes a conflict to `canAdoptRepo` and the individual path passes none.

Four things had to change for sharing to be honest rather than merely permitted:

* **`autograde_runs.workflowRunId` is no longer globally unique.** One workflow run on
  a shared repository has to produce a row per student; with a global unique exactly
  one of them got a score and the rest looked as though they had never submitted.
  Uniqueness moved to `(assignmentRepoId, workflowRunId)`, which is still what makes a
  repeated webhook delivery idempotent.
* **Ingestion fans out.** The artifact is fetched and parsed once, then written to
  every row grading that repository — see `selectAutogradeTargets`
  (`src/lib/autograding/fanout.ts`) for which rows those are. A run is skipped only
  when *every* target already has it, so an ingestion that died after the first write
  finishes the rest on retry instead of stopping at one `COMPLETED` row.
* **Project boards are shared, not duplicated.** A board is linked to a repository, so
  the job reuses a board already recorded against a sibling row rather than creating a
  second identically titled one, and shares it with every student on the repository.
  The old `projectUrl` check could not see across rows.
* **Removing one student never archives or deletes the repository.** Revoking access is
  a statement about that student; archiving would freeze everyone else's work and
  deleting would destroy it. `revokeStudentAccess` downgrades the destructive half to
  KEEP whenever another row still points at the repository, and records why on the row.

Deadlines needed nothing. The sweep already acts per row using each student's own
GitHub login, so on a shared repository a student with an extension keeps write access
while the others are locked to read — which is the correct behaviour and came for free.
