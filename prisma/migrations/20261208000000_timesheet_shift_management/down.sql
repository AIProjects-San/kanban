-- G4 — lossless down: the four tables are brand new (no rows predate the
-- migration), and the AttendanceRecord link is additive + nullable (pre-G4
-- rows never had it). Dropping the link column and the tables returns the
-- db to the exact pre-G4 shape; the timesheet/roster UIs degrade to empty
-- lists (their readers gate on the models existing).

ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_shiftAssignmentId_fkey";

ALTER TABLE "AttendanceRecord" DROP COLUMN "shiftAssignmentId";

DROP INDEX "ShiftAssignment_shiftId_idx";

DROP INDEX "ShiftAssignment_rosterDate_idx";

DROP INDEX "TimesheetLine_workDate_idx";

DROP INDEX "TimesheetLine_timesheetId_idx";

DROP INDEX "Timesheet_status_idx";

DROP INDEX "Timesheet_employeeId_periodStart_idx";

DROP INDEX "Timesheet_payrollRunId_idx";

DROP TABLE "ShiftAssignment";

DROP TABLE "Shift";

DROP TABLE "TimesheetLine";

DROP TABLE "Timesheet";
