-- Optional per-student (or per-team) project boards, owned by the classroom's
-- GitHub organization and linked to each assignment repository.
--
-- Organization-owned rather than student-owned because GitHub only lists projects
-- owned by the same account that owns the repository, so a personal board can never
-- be linked to an assignment repository.
ALTER TABLE "assignments" ADD COLUMN "projectBoardEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Remembered so a retry links the board that already exists instead of creating a
-- second one: GitHub allows any number of identically titled projects.
ALTER TABLE "assignment_repos" ADD COLUMN "projectUrl" TEXT;
ALTER TABLE "assignment_repos" ADD COLUMN "projectNumber" INTEGER;
