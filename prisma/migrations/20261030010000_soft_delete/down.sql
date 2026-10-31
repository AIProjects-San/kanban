-- Down migration for 20261030010000_soft_delete
-- Reverses: ADD COLUMN deletedAt on Message, Project, TeamMember, User
--
-- ⚠️ DATA LOSS: dropping `deletedAt` permanently destroys the soft-delete
-- marker. Any soft-deleted rows become "live" again (they'll show up in
-- read paths that filter `deletedAt: null`). Run this ONLY if you're sure
-- no soft-deleted rows exist, or if you're tearing down the workspace.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "Message" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "TeamMember" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "deletedAt";
