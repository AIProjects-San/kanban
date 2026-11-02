-- Down migration for 20261102000000_bug_tracking
-- Reverses: CREATE TABLE Bug + BugComment (with indexes and FK)
--
-- ⚠️ DATA LOSS: destroys every bug, its comments, and their links to tasks.
-- Audit history for bug.* events lives in AuditLog and is unaffected, but
-- the Bug tracker becomes empty. Coordinate with the QA team before running.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP INDEX IF EXISTS "BugComment_authorId_idx";
DROP INDEX IF EXISTS "BugComment_bugId_idx";
DROP TABLE IF EXISTS "BugComment";
DROP INDEX IF EXISTS "Bug_createdAt_idx";
DROP INDEX IF EXISTS "Bug_projectId_idx";
DROP INDEX IF EXISTS "Bug_assigneeUserId_idx";
DROP INDEX IF EXISTS "Bug_reporterUserId_idx";
DROP INDEX IF EXISTS "Bug_priority_idx";
DROP INDEX IF EXISTS "Bug_severity_idx";
DROP INDEX IF EXISTS "Bug_status_idx";
DROP TABLE IF EXISTS "Bug";
