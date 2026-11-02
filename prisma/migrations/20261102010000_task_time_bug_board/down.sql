-- Down migration for 20261102010000_task_time_bug_board
-- Reverses: Task.estimateMinutes, TimeEntry.taskId (+FK/index), Bug.boardOrder
-- and the Bug.taskId FK/index added by this migration.
--
-- ⚠️ DATA LOSS: drops logged time-to-task links (TimeEntry.taskId) and every
-- task estimate. Logged hours themselves (TimeEntry rows) survive, but they
-- can no longer be aggregated per task.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "Bug" DROP CONSTRAINT IF EXISTS "Bug_taskId_fkey";
DROP INDEX IF EXISTS "Bug_taskId_idx";
ALTER TABLE "Bug" DROP COLUMN IF EXISTS "boardOrder";
ALTER TABLE "TimeEntry" DROP CONSTRAINT IF EXISTS "TimeEntry_taskId_fkey";
DROP INDEX IF EXISTS "TimeEntry_taskId_idx";
ALTER TABLE "TimeEntry" DROP COLUMN IF EXISTS "taskId";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "estimateMinutes";
