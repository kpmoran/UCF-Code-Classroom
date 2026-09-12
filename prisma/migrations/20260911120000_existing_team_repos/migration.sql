-- Group assignments that adopt repositories which already exist.
--
-- The original path always creates a repository per team, from the template or
-- empty. A course whose team projects live in repositories that predate the
-- assignment had no way to use this app for them at all. With repoSource set to
-- EXISTING, provisioning skips creation and adopts the repository an instructor
-- linked to the team; every other step — the GitHub team, its memberships, the
-- team's permission on the repository, autograding, deadlines — is unchanged.
--
-- Defaulting to CREATE keeps every existing assignment on the behaviour it was
-- created with.
CREATE TYPE "RepoSource" AS ENUM ('CREATE', 'EXISTING');

ALTER TABLE "assignments"
  ADD COLUMN "repoSource" "RepoSource" NOT NULL DEFAULT 'CREATE';
