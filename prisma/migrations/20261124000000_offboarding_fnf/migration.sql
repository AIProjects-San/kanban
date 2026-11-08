-- F2.1 — offboarding & full-and-final lite
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.1; benchmark rows
-- EM-14/EM-15/EM-16 + behaviors EM-B12/B14, notification EM-T01 lite).
--
-- Three moves, all additive:
--   1. OnboardingChecklist.kind — the SEPARATION flag that reuses the
--      onboarding checklist machinery for exit checklists. Default
--      'ONBOARDING' keeps every pre-F2.1 row on the onboarding side
--      (zero-behavior rollout).
--   2. ExitInterview — PENDING → SCHEDULED → COMPLETED/CANCELLED, one
--      LIVE row per employee (action-enforced; CANCELLED rows are kept as
--      history), interviewer + notes.
--   3. FullAndFinalStatement — one row per employee (unique — settlement
--      is final), UNSETTLED → SETTLED; lines/totals frozen at settlement.
--
-- No backfill: an exit story that predates F2.1 never existed in the
-- product (the EXITED arc itself landed with F1.6 and stays empty until
-- HR records a real exit).

-- AlterTable
ALTER TABLE "OnboardingChecklist" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ONBOARDING';

-- CreateTable
CREATE TABLE "ExitInterview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "interviewerId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FullAndFinalStatement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNSETTLED',
    "lastWorkingDay" TIMESTAMP(3),
    "asOf" TIMESTAMP(3),
    "lines" TEXT NOT NULL DEFAULT '[]',
    "payableTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "receivableTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPayable" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generatedById" TEXT NOT NULL DEFAULT '',
    "settledById" TEXT NOT NULL DEFAULT '',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingChecklist_kind_idx" ON "OnboardingChecklist"("kind");
CREATE INDEX "ExitInterview_userId_idx" ON "ExitInterview"("userId");
CREATE INDEX "ExitInterview_status_idx" ON "ExitInterview"("status");
CREATE INDEX "ExitInterview_createdAt_idx" ON "ExitInterview"("createdAt");
CREATE INDEX "FullAndFinalStatement_status_idx" ON "FullAndFinalStatement"("status");

-- CreateIndex — one statement per employee: settlement is final.
CREATE UNIQUE INDEX "FullAndFinalStatement_userId_key" ON "FullAndFinalStatement"("userId");
