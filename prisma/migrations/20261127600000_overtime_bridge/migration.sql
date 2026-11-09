-- P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge.
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 9).
--
-- Additive: AttendanceRecord.overtimeMinutes (the S2 derived fact — minutes
-- beyond the workspace day end, written with the same discipline as
-- lateMinutes/earlyMinutes) and Workspace.overtimePayEnabled (the payout
-- setting, default OFF — overtime pay is a policy choice, never a surprise
-- payslip line). The bridge itself is pure code (lib/overtime-bridge.ts):
-- run creation sums the period's minutes per employee and prices one
-- "Overtime" earning line from the structure gross ÷ working days ÷ 8h.

ALTER TABLE "AttendanceRecord" ADD COLUMN "overtimeMinutes" INTEGER;

ALTER TABLE "Workspace" ADD COLUMN "overtimePayEnabled" BOOLEAN NOT NULL DEFAULT false;
