-- P1 (PR-12/PR-B10, F2.3) — the PayAdjustment universal adapter (docs/
-- Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep). New table;
-- purely additive — no existing column changes, no behavior change for
-- existing runs (an empty table means createPayrollRun consumes nothing,
-- byte-identical output).
--
-- Every special payment flow (encashment, arrears deltas, LWP credits,
-- retention bonus, benefit payouts, withheld release, manual incentives)
-- funnels into ONE row consumed by the run covering its period, inside
-- that run's creation transaction. Calc modes: FIXED / PERCENT_OF_GROSS /
-- PERCENT_OF_NET (two-pass ordering — gross-based lines first, percent-of-
-- net deductions sequentially afterwards). Recurrence: ONE_SHOT /
-- RECURRING (through endPeriod, lastConsumedPeriod watermark) / OVERWRITE
-- (replaces the same-key line for one period).

CREATE TABLE "PayAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT NOT NULL DEFAULT '',
    "componentCode" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "side" TEXT NOT NULL DEFAULT 'EARNING',
    "recurrence" TEXT NOT NULL DEFAULT 'ONE_SHOT',
    "calcMode" TEXT NOT NULL DEFAULT 'FIXED',
    "percent" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "period" TEXT NOT NULL,
    "endPeriod" TEXT,
    "lastConsumedPeriod" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "consumedRunId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PayAdjustment_period_status_idx" ON "PayAdjustment"("period", "status");
CREATE INDEX "PayAdjustment_userId_status_idx" ON "PayAdjustment"("userId", "status");
