-- The org team that holds a classroom's instructors and TAs.
--
-- Until now nothing granted staff access to student repositories at all: the TA
-- role existed only inside the app, and an instructor could read repositories only
-- by being an organization owner. A TA who was a plain org member saw nothing.
--
-- Nullable on purpose. The team is created on demand, because creating org teams
-- needs the organization-owner credential rather than the App's own token, and a
-- classroom may not have one connected.
ALTER TABLE "classrooms" ADD COLUMN "staffTeamSlug" TEXT;
