-- P15 (PR-06) — partially-paid leave fraction + the per-slip charge detail.
--
-- LeaveType.salaryFraction: the benchmark's fraction_of_daily_salary_per_leave.
-- Default 1 = fully paid = the pre-P15 semantics byte-for-byte (additive,
-- zero behavior change); the LOP derivation charges (1 − fraction) working
-- days per day of a paid type at fraction < 1. Unpaid types keep charging
-- the full working fraction (paid = false is fraction 0 by definition).
--
-- Payslip.lopDetail: the per-slip leave-charge breakdown frozen at creation
-- (the Salary Slip Leave child rows, Fernly-shaped) — nullable, so every
-- pre-P15 slip reads as "no detail recorded" and nothing backfills.

ALTER TABLE "LeaveType" ADD COLUMN "salaryFraction" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "Payslip" ADD COLUMN "lopDetail" JSONB;
