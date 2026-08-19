-- Data migration, not a schema change.
--
-- isFaculty defaults to false, so introducing the gate would lock out every
-- instructor who already runs a classroom here — including whoever deployed this.
-- Anyone already recorded as an INSTRUCTOR of a classroom demonstrably belongs on
-- the faculty side of the line, so grant it to them once, at the moment the column
-- appears. Future instructors come in through an invite.
UPDATE "users"
SET "isFaculty" = true
WHERE "id" IN (
  SELECT DISTINCT "userId" FROM "classroom_members" WHERE "role" = 'INSTRUCTOR'
);
