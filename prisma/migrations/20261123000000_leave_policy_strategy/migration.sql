-- F2.4 — leave policy engine: the allocation strategy block on LeavePolicy
-- (docs/Fernly_Policy_Engine_Design.md §4.1; docs/Fernly_HR_Payroll_
-- Enhancement_Plan.md §7.2 F2.4). Additive only — no new tables, no
-- backfill, no data repair.
--
-- Zero-behavior rollout (design doc §8): every column's default reproduces
-- the pre-F2.4 semantics exactly —
--   allocationStrategy 'MANUAL'      → grant-on-first-use materialization
--                                       (the existing path, untouched);
--   allowNegative false / floor 0    → the classic overdraft guard
--                                       (days > available rejects);
--   countHolidaysInLeave false       → the F1.1 holiday-aware day count;
--   accrualCap / carryExpiresAfterMonths NULL → annualDays cap / never lapse.
-- Existing rows read as MANUAL types the moment the columns land; the
-- engine (writers + cron) is the only thing the code adds.
ALTER TABLE "LeavePolicy" ADD COLUMN "allocationStrategy" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "LeavePolicy" ADD COLUMN "accrualFrequency" TEXT NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "LeavePolicy" ADD COLUMN "allocateOnDay" TEXT NOT NULL DEFAULT 'FIRST';
ALTER TABLE "LeavePolicy" ADD COLUMN "accrualRounding" TEXT NOT NULL DEFAULT 'FLOOR_QUARTER';
ALTER TABLE "LeavePolicy" ADD COLUMN "accrualCap" DOUBLE PRECISION;
ALTER TABLE "LeavePolicy" ADD COLUMN "grantOn" TEXT NOT NULL DEFAULT 'PERIOD_START';
ALTER TABLE "LeavePolicy" ADD COLUMN "prorateForJoiners" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LeavePolicy" ADD COLUMN "minServiceMonths" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LeavePolicy" ADD COLUMN "accrueDuringProbation" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LeavePolicy" ADD COLUMN "allowNegative" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN "negativeFloor" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "LeavePolicy" ADD COLUMN "carryExpiresAfterMonths" INTEGER;
ALTER TABLE "LeavePolicy" ADD COLUMN "countHolidaysInLeave" BOOLEAN NOT NULL DEFAULT false;
