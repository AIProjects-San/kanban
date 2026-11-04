-- Recruitment module R2 — interview scheduling + scorecards
-- (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R2).
-- Additive only: four new columns on CandidateStage. No table or constraint
-- changes; existing rows default cleanly (empty strings / NULL).

ALTER TABLE "CandidateStage" ADD COLUMN "strengths" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CandidateStage" ADD COLUMN "concerns" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CandidateStage" ADD COLUMN "recommendation" TEXT;
ALTER TABLE "CandidateStage" ADD COLUMN "eventId" TEXT;
