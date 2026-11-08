-- AT-B02/B03 (S2) — attendance timing facts (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1.1 residual sweep). Additive columns only; no new table. Existing rows
-- read as "not computable" (NULL) for all three facts — honest: their
-- in/out times were never evaluated against a reference day, and a
-- retroactive re-derivation would invent history.
--
-- AttendanceRecord.lateMinutes / earlyMinutes / workingHours: derived at
-- write time by the pure kernel lib/attendance-flags.ts from inTime/outTime
-- against the workspace default day. NULL = the dependent time is absent.
--
-- Workspace.attendanceDayStart / attendanceDayEnd: the reference day
-- (defaults 09:00 / 17:30). Shifts (F3.5) will supersede the reference; the
-- rule stays pure and the knob stays data.

ALTER TABLE "Workspace" ADD COLUMN "attendanceDayStart" TEXT NOT NULL DEFAULT '09:00',
ALTER TABLE "Workspace" ADD COLUMN "attendanceDayEnd" TEXT NOT NULL DEFAULT '17:30';
ALTER TABLE "AttendanceRecord" ADD COLUMN "lateMinutes" INTEGER;
ALTER TABLE "AttendanceRecord" ADD COLUMN "earlyMinutes" INTEGER;
ALTER TABLE "AttendanceRecord" ADD COLUMN "workingHours" DOUBLE PRECISION;
