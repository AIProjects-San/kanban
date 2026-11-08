-- F2.1 down (ADR-008 discipline).
-- Reversibility notes:
--   • Dropping OnboardingChecklist."kind" reverts every separation
--     checklist to the ONBOARDING default — with the exit-interview and
--     FnF tables also gone, no reader of the column survives the rollback,
--     so the schema stays self-consistent.
--   • Dropping ExitInterview loses the interview record + notes; the
--     in-app scheduling notifications are generic Notification rows and
--     stay (they are informational history, not structural state).
--   • Dropping FullAndFinalStatement loses the frozen settlement
--     snapshots AND releases the payslip-edit lock they held — acceptable
--     for a rollback: the lock only ever guarded SETTLED statements, and
--     rolling the epic back means the whole exit surface is gone by
--     design. Re-running the up starts every exit story over.
DROP INDEX IF EXISTS "FullAndFinalStatement_userId_key";
DROP INDEX IF EXISTS "FullAndFinalStatement_status_idx";
DROP TABLE IF EXISTS "FullAndFinalStatement";
DROP INDEX IF EXISTS "ExitInterview_createdAt_idx";
DROP INDEX IF EXISTS "ExitInterview_status_idx";
DROP INDEX IF EXISTS "ExitInterview_userId_idx";
DROP TABLE IF EXISTS "ExitInterview";
DROP INDEX IF EXISTS "OnboardingChecklist_kind_idx";
ALTER TABLE "OnboardingChecklist" DROP COLUMN IF EXISTS "kind";
