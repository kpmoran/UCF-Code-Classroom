-- An assignment repo belongs to exactly one owner: a student (individual
-- assignment) or a team (group assignment), never both and never neither.
-- Prisma's schema language cannot express this, so it is enforced here. Without
-- it, a bug that sets both would silently create a repo that appears in two
-- places in the UI and double-counts in grade export.
ALTER TABLE "assignment_repos"
  ADD CONSTRAINT "assignment_repos_exactly_one_owner"
  CHECK (("userId" IS NOT NULL) <> ("teamId" IS NOT NULL));

-- Same rule for deadline extensions.
ALTER TABLE "extensions"
  ADD CONSTRAINT "extensions_exactly_one_owner"
  CHECK (("userId" IS NOT NULL) <> ("teamId" IS NOT NULL));
