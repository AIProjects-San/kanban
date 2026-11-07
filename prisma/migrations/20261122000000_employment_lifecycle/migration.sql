-- F1.6 — employment lifecycle (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1; benchmark: frappe/hrms employment status / probation). Four nullable
-- or default-carrying columns on EmployeeProfile + the review-kind marker
-- that powers the §9.3 probation hard gate.
--
-- employmentStatus defaults to '' ("not tracked yet") — the QA-19 no-
-- fabrication discipline: self-created profiles must not claim an
-- HR-asserted employment fact. The status column is written exclusively by
-- the guarded transitionEmployment action (never the plain profile edit).
--
-- Backfill (honest, one-shot): every profile WITH a recorded hireDate is
-- treated as an ACTIVE employee. Nothing that could EXIT, SUSPEND or leave
-- PROBATION ever existed in the product before this migration, so a
-- recorded hire date is the strongest available evidence of present
-- employment. Profiles without a hireDate (self-created) keep '' until HR
-- classifies them. Re-running after a down is idempotent (same predicate).

-- AlterTable
ALTER TABLE "EmployeeProfile" ADD COLUMN "employmentStatus" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EmployeeProfile" ADD COLUMN "probationEndsAt" TIMESTAMP(3);
ALTER TABLE "EmployeeProfile" ADD COLUMN "noticePeriodWeeks" INTEGER;
ALTER TABLE "EmployeeProfile" ADD COLUMN "lastWorkingDay" TIMESTAMP(3);

-- AlterTable — F1.6 review kind: STANDARD (every pre-existing cycle) or
-- PROBATION (created explicitly via the review UI's type select).
ALTER TABLE "PerformanceReview" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STANDARD';

-- Backfill — present employees become ACTIVE.
UPDATE "EmployeeProfile" SET "employmentStatus" = 'ACTIVE' WHERE "hireDate" IS NOT NULL;

-- CreateIndex
CREATE INDEX "EmployeeProfile_employmentStatus_idx" ON "EmployeeProfile"("employmentStatus");
