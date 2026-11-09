-- P4 (PR-14/PR-B12, F3.1) — LWP correction reversal rides the P1 adapter
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 4).
--
-- Additive nullable column: the day-quantity a source row moved. LWP_CREDIT
-- rows store the reversed LOP days so the per-slip reversal cap
-- (Σ reversed ≤ stored lopDays) is enforced from data, never note-parsing.
-- Null for every existing row (not day-denominated sources).

ALTER TABLE "PayAdjustment" ADD COLUMN "sourceDays" DOUBLE PRECISION;
