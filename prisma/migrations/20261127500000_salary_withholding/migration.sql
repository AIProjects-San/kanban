-- P8 (PR-19/PR-B13, F3.3) — salary withholding (hold window + release).
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 8).
--
-- Additive: the new SalaryWithholding table (the ACTIVE hold window and
-- its terminal RELEASED state with release bookkeeping) and the
-- Payslip.withholdStatus column ("" | WITHHELD | RELEASED) stamped at slip
-- creation. The release pays through the P1 adapter (WITHHOLDING_RELEASE
-- rows) — no money columns move here.

ALTER TABLE "Payslip" ADD COLUMN "withholdStatus" TEXT NOT NULL DEFAULT '';

CREATE TABLE "SalaryWithholding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fromPeriod" TEXT NOT NULL,
    "untilPeriod" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL DEFAULT '',
    "releasedById" TEXT NOT NULL DEFAULT '',
    "releasedAt" DATETIME,
    "releasePeriod" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "SalaryWithholding_userId_status_idx" ON "SalaryWithholding"("userId", "status");
