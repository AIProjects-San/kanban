-- Board enhancements — Task time log (required vs spent), Task ↔ Bug
-- traceability link, and Bug board column ordering.

-- 1. Task: required (estimated) time in minutes. 0 = no estimate.
ALTER TABLE "Task" ADD COLUMN "estimateMinutes" INTEGER NOT NULL DEFAULT 0;

-- 2. TimeEntry: optional link to the task this time was spent on.
--    Spent time on a task = SUM(hours) over entries with taskId = task.
ALTER TABLE "TimeEntry" ADD COLUMN "taskId" TEXT;
CREATE INDEX "TimeEntry_taskId_idx" ON "TimeEntry"("taskId");
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Bug: the taskId column already existed (bug_tracking migration) but had
--    no relation. Add the FK + index so a task's linked bugs can be queried,
--    and boardOrder so cards keep a stable position inside each board column.
ALTER TABLE "Bug" ADD COLUMN "boardOrder" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Bug_taskId_idx" ON "Bug"("taskId");
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
