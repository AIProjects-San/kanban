-- P35 (EM-12, EM-B06, EM-11, EM-14) — onboarding/separation template depth:
-- user-XOR-role assignee, per-task required flag, holiday-aware due dates
-- and the derived completion status.
--
-- The benchmark's Employee Onboarding Template carries three per-activity
-- facts Fernly's F2.10 template table lacked:
--
--   • user XOR role assignee — a template task can pin ONE user (the
--     instantiated task lands on that user, exactly like addTask's picker)
--     OR a role key (the task stays role-scoped: assigneeId stays NULL and
--     every holder of the role sees and can tick it). Exactly one of the
--     two may be set — the zod boundary enforces the XOR, the columns are
--     nullable/''-defaulted so legacy rows mean "neither" (the historical
--     self/manager discipline keeps applying).
--   • required_for_employee_creation → isRequired on the template row AND
--     the instantiated task (the flag rides the instantiation like
--     dueOffsetDays does).
--   • holiday-aware task dates → OnboardingTask.dueDate: the working-day
--     walk of startDate + dueOffsetDays (weekends + full holiday-calendar
--     entries never count). OnboardingChecklist.startDate anchors the walk
--     (the profile's hireDate / lastWorkingDay, HR-pinnable); nullable so
--     pre-P35 rows read as "not yet dated" rather than a fabricated today.
--
-- EM-11's boarding status is DERIVED from the task rows at read time (the
-- completion percent kernel) — no column, by design.

ALTER TABLE "OnboardingTemplateTask" ADD COLUMN "assigneeUserId" TEXT;
ALTER TABLE "OnboardingTemplateTask" ADD COLUMN "assigneeRole" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OnboardingTemplateTask" ADD COLUMN "isRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "OnboardingChecklist" ADD COLUMN "startDate" TIMESTAMP(3);

ALTER TABLE "OnboardingTask" ADD COLUMN "assigneeRole" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OnboardingTask" ADD COLUMN "isRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OnboardingTask" ADD COLUMN "dueDate" TIMESTAMP(3);
