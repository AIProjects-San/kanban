-- Down migration for 20261112000000_hiring_interviews
-- Reverses: the four R2 columns on CandidateStage.
--
-- ⚠️ DATA LOSS: destroys every interview scorecard and the calendar-event
-- links. The calendar events themselves (CalendarEvent rows) are untouched.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "CandidateStage" DROP COLUMN IF EXISTS "eventId";
ALTER TABLE "CandidateStage" DROP COLUMN IF EXISTS "recommendation";
ALTER TABLE "CandidateStage" DROP COLUMN IF EXISTS "concerns";
ALTER TABLE "CandidateStage" DROP COLUMN IF EXISTS "strengths";
