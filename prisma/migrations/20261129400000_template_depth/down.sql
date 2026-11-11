-- P35 — lossless down: every added column was additive (nullable or with a
-- neutral default), no existing column changed, no backfill — dropping the
-- seven restores the pre-P35 schema exactly and pre-P35 rows never held a
-- value in them.

ALTER TABLE "OnboardingTask" DROP COLUMN "dueDate";
ALTER TABLE "OnboardingTask" DROP COLUMN "isRequired";
ALTER TABLE "OnboardingTask" DROP COLUMN "assigneeRole";
ALTER TABLE "OnboardingChecklist" DROP COLUMN "startDate";
ALTER TABLE "OnboardingTemplateTask" DROP COLUMN "isRequired";
ALTER TABLE "OnboardingTemplateTask" DROP COLUMN "assigneeRole";
ALTER TABLE "OnboardingTemplateTask" DROP COLUMN "assigneeUserId";
