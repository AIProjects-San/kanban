-- F2.10 — joining hardening (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.2 F2.10; benchmark rows RJ-* offer→join chain, E4/E5 onboarding
-- templates + joining gate; defects F-R5/F-R6/F-R7/F-R8/F-R9/F-R11).
--
-- Five moves:
--   1. OfferRecord approval + start date + EXPIRED outcome:
--      approvedById/approvedAt carry the DRAFT → APPROVED step (a manager
--      distinct from the composer — four-eyes, R11/D-20); startDate feeds
--      the {{startDate}} letter placeholder (F-R11 — it rendered empty);
--      EXPIRED becomes a real stored outcome lapsed lazily by
--      lapseExpiredSentOffers() on hiring reads (F-R5).
--   2. Reminder.eventId — the interview reminder's link to its calendar
--      event so a reschedule deletes the stale pair (F-R6 orphans).
--   3. OnboardingTemplateTask — the ONE configurable template source
--      replacing the three drifted code copies (F-R8).
--   4. Workspace.joiningGateEnabled — the configurable markJoined
--      precondition: every mandatory document VERIFIED + every background
--      check terminal (F-R9/E5). Default TRUE — the gated behavior is the
--      epic's point (a deliberate, documented behavior change, NOT the
--      usual zero-behavior default; Settings → General can turn it off).
--
-- No backfill: existing DRAFT/SENT offers simply sit where they are — a
-- SENT offer predating F2.10 keeps its old semantics until its link
-- lapses (then it honestly reads EXPIRED); existing reminders keep
-- eventId NULL (standalone personal reminders, the pre-F2.10 shape).

-- AlterTable
ALTER TABLE "OfferRecord" ADD COLUMN "startDate" TIMESTAMP(3),
ADD COLUMN "approvedById" TEXT NOT NULL DEFAULT '',
ADD COLUMN "approvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN "eventId" TEXT;

-- CreateIndex
CREATE INDEX "Reminder_eventId_idx" ON "Reminder"("eventId");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "joiningGateEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "OnboardingTemplateTask" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ONBOARDING',
    "title" TEXT NOT NULL,
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 7,
    "assignSelf" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingTemplateTask_kind_idx" ON "OnboardingTemplateTask"("kind");
CREATE INDEX "OnboardingTemplateTask_sortOrder_idx" ON "OnboardingTemplateTask"("sortOrder");
