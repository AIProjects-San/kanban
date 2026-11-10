-- P26 — rollback of the interview reminder engine's schema. Lossless:
-- the switches' positions are lost, but no business data (notifications
-- and outbox rows keep their rows; the stage rows are untouched).

ALTER TABLE "Workspace" DROP COLUMN "remindInterviews";
ALTER TABLE "Workspace" DROP COLUMN "emailInterviewReminders";
