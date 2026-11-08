-- PR-B06 (S5) — joiner/exiter payment-day clipping
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive nullable column; existing rows read as full-period (NULL =
-- pre-S5, no retroactive rewrite of paid history — snapshot discipline).
--
-- Payslip.paidDays: working days in [max(period start, hireDate),
-- min(period end, lastWorkingDay)], snapshotted at run/slip creation by
-- the pure paymentWindow rule (lib/working-days.ts). Earnings scale by
-- paidDays / run.workingDays (lib/payroll-math.ts scaleEarningsToPaidDays)
-- so a mid-month joiner is paid for the days they were employed — a
-- deliberate default-ON correctness fix (F2.10 joining-gate precedent):
-- before S5 a joiner received a full month's gross. The LOP derivation
-- already refuses to charge outside the same window (S4).

ALTER TABLE "Payslip" ADD COLUMN "paidDays" DOUBLE PRECISION;
