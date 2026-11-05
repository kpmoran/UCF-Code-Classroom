-- Students become organization members when they join a classroom, so assignment
-- repositories are granted directly rather than through per-repository invitations
-- that expire after seven days.
--
-- Existing classrooms are added with the feature off: a term already in progress
-- keeps working the way its students know. The column default is then switched on,
-- so classrooms created from here on use it.
ALTER TABLE "classrooms" ADD COLUMN "studentOrgAccess" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "classrooms" ALTER COLUMN "studentOrgAccess" SET DEFAULT true;
ALTER TABLE "classrooms" ADD COLUMN "studentTeamSlug" TEXT;

ALTER TABLE "classroom_members" ADD COLUMN "orgState" TEXT;
ALTER TABLE "classroom_members" ADD COLUMN "orgInvitedAt" TIMESTAMP(3);
ALTER TABLE "classroom_members" ADD COLUMN "orgFailure" TEXT;
ALTER TABLE "classroom_members" ADD COLUMN "orgJoinedViaClassroom" BOOLEAN NOT NULL DEFAULT false;
