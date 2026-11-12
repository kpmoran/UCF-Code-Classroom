# Exporting grades to Canvas

From a classroom, open **Grades → Download CSV**, then in Canvas go to
**Grades → Import** and upload it.

Canvas matches rows on the identity columns it emitted — `Student`, `ID`,
`SIS User ID`, `SIS Login ID`, `Section` — so the export reproduces them
**verbatim from the file you imported**. That is why roster import keeps every
source column in `rawColumns`: reconstructing those fields from normalized values
works until a name contains something that got normalized away, at which point
Canvas silently creates a second row instead of matching.

Two behaviours worth knowing before you import:

- **A blank cell means "no change".** Students with no score — never submitted, or
  never linked a GitHub account — export blank rather than as `0`, because a zero
  actively records a failing grade.
- **The "Points Possible" row is off by default.** Leave it off unless you want the
  import to overwrite each assignment's point value in Canvas.

A manual override always beats the autograded score. Click any cell in the
gradebook to set one; clear the field to fall back to autograding.
