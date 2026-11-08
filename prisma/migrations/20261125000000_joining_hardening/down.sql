-- F2.10 down (ADR-008 discipline).
-- Reversibility notes:
--   • Dropping the OfferRecord approval/start-date columns loses the
--     approval trail and the negotiated start date (the letter snapshot
--     keeps its rendered text — it never re-reads startDate); offers fall
--     back to the DRAFT/SENT/SIGNED/DECLINED vocabulary. EXPIRED rows are
--     the only ones with no pre-F2.10 meaning: rolling back while an
--     EXPIRED row exists leaves a status the old readers treat as
--     immutable-but-unknown (updateOfferRecord refuses it; the offers
--     panel shows the raw chip). Update such rows to 'DECLINED' first if
--     a clean rollback is needed.
--   • Dropping Reminder.eventId orphans nothing: cascading deletes only
--     ever fired for interview reminders, and their events go with the
--     epic's scheduleInterview rewrite anyway.
--   • Dropping OnboardingTemplateTask reverts template instantiation to
--     the code constants (lib/onboarding-template.ts) — instantiated
--     checklists/tasks are plain rows and survive unchanged.
--   • Dropping Workspace.joiningGateEnabled turns the joining gate OFF
--     (the old advisory behavior) — the intended rollback semantics.
DROP INDEX IF EXISTS "OnboardingTemplateTask_kind_idx";
DROP INDEX IF EXISTS "OnboardingTemplateTask_sortOrder_idx";
DROP TABLE IF EXISTS "OnboardingTemplateTask";
ALTER TABLE "Workspace" DROP COLUMN "joiningGateEnabled";
ALTER TABLE "Reminder" DROP CONSTRAINT IF EXISTS "Reminder_eventId_fkey";
DROP INDEX IF EXISTS "Reminder_eventId_idx";
ALTER TABLE "Reminder" DROP COLUMN "eventId";
ALTER TABLE "OfferRecord" DROP COLUMN "approvedAt";
ALTER TABLE "OfferRecord" DROP COLUMN "approvedById";
ALTER TABLE "OfferRecord" DROP COLUMN "startDate";
