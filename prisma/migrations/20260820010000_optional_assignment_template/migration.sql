-- An assignment may start from nothing rather than from a template repository,
-- in which case each student gets an empty repository to push into.
--
-- Both columns move together: there is no meaningful state where a repository
-- name exists without an owner, so nullability is applied to the pair.
ALTER TABLE "assignments" ALTER COLUMN "templateOwner" DROP NOT NULL;
ALTER TABLE "assignments" ALTER COLUMN "templateRepo" DROP NOT NULL;
