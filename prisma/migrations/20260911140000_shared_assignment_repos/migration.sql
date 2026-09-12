-- Several students assigned to one repository.
--
-- An individual assignment with repoSource EXISTING may point more than one student
-- at the same repository — a shared course project, or students reviewing the same
-- codebase. Each student keeps their own assignment_repos row, so access, deadlines,
-- extensions and grades stay per-student; the rows simply share a fullName and a
-- githubRepoId.
--
-- The one thing that could not cope was autograde_runs.workflowRunId being globally
-- unique. One workflow run on a shared repository has to produce a run row for every
-- student on it, otherwise exactly one of them gets a score and the rest appear never
-- to have submitted. Uniqueness moves to (assignmentRepoId, workflowRunId), which is
-- still what makes a repeated webhook delivery idempotent.
DROP INDEX "autograde_runs_workflowRunId_key";

CREATE UNIQUE INDEX "autograde_runs_assignmentRepoId_workflowRunId_key"
  ON "autograde_runs" ("assignmentRepoId", "workflowRunId");

-- Lookups by run id alone remain (the re-sync path), but are no longer unique.
CREATE INDEX "autograde_runs_workflowRunId_idx" ON "autograde_runs" ("workflowRunId");
