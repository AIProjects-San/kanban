-- PR-B07 (S4) — consider_unmarked_attendance_as as workspace data
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive column; default IGNORED = the pre-S4 derivation semantics
-- byte-for-byte (unmarked days never charge). Flipping to ABSENT makes the
-- createPayrollRun/addPayslip LOP derivation charge unmarked working days
-- inside each employee's [hireDate, lastWorkingDay] window as absent — the
-- benchmark's Payroll Settings knob, scoped to a single workspace row.

ALTER TABLE "Workspace" ADD COLUMN "unmarkedAttendanceMode" TEXT NOT NULL DEFAULT 'IGNORED';
