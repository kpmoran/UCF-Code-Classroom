# Linking students straight to an assignment

An assignment is reachable at either form, scoped to the classroom:

```
https://code-classroom.com/classrooms/<classroom-slug>/assignments/<assignment-slug>
https://code-classroom.com/classrooms/<classroom-slug>/assignments/<assignment-id>
```

Use the slug for anything a person reads or retypes — a syllabus, a Canvas page, a
slide. It is derived from the title when the assignment is created and deduplicated
within the classroom, so `hw1-unit-testing` beats a 25-character cuid. The id keeps
working, so links already shared do not break.

**A signed-out student ends up in the right place.** The proxy sends them to `/signin`
with the destination in `next`, and sign-in returns them to the assignment rather than
to a dashboard, so a link from a course website works on a first visit.

**But they must already have joined the classroom.** A signed-in person who is not a
member gets a **404**, not a prompt to join — deliberately, so classroom and assignment
URLs are not enumerable across every course on the instance. The consequence for you is
that the invite link is still the first thing a cohort needs; assignment links are for
students already registered.

So the order that works is: share the invite link once at the start of term, then link
individual assignments freely for the rest of it.
