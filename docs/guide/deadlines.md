# Deadlines

A sweep runs every five minutes rather than a job scheduled per deadline, so it
survives a restart at 23:55 and re-derives state after a deadline is edited or an
extension granted. `src/lib/deadlines/resolve.ts` holds the rules as pure
functions: an extension always wins (including one that moves a deadline
*earlier*), lateness is judged on the last push rather than the current time, and
granting an extension unlocks a repository that was already locked.

At the deadline each repository's submitted commit is recorded in `deadlineSha`,
whether or not `lockOnDeadline` is set — capturing the on-time state while
students keep working is the common arrangement.

The capture asks GitHub for the commit **as of the deadline**, not for the current
head. This matters more than it looks: the sweep runs on a five-minute cycle, so
reading the head recorded whatever happened to be there when it ran, and a push at
23:59:30 against a 23:59 deadline became the student's submitted commit purely
because the sweep had not arrived yet. Asking as of the deadline makes the result
identical whether the sweep is one second or four minutes late.

`deadlineSha` distinguishes three states, and collapsing them loses real
information: `null` means the deadline has not passed or the sweep has not run,
a sha means that commit is what would be graded, and the empty string means the
sweep looked and found no commit dated before the deadline — a repository that was
empty, or one a student accepted after the deadline had already passed.

Staff see all three as a column in the repository table; students see the same
facts about their own work, on both the individual and the team assignment pages.
`summarizeSubmission` in `src/lib/deadlines/summary.ts` is the single definition
all three views share, because lateness depends on the *effective* deadline and an
extension makes that per student — three inline copies would be three chances for a
student's page to disagree with their instructor's about whether they were late.

Students are shown only their own team's submission, never the rest of the class's.
