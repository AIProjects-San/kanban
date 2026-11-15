-- G4 (F3.4/F3.5) — timesheet + shift management (docs plan §"timesheet and
-- shift"): shifts define EXPECTED hours (the roster), timesheets carry
-- ACTUAL hours (self-service drafts → HR approval), and the approved
-- timesheet is the hours override a payroll run may consume. The
-- createPayrollRun consumption hook itself ships behind review (see the
-- G4 report); the schema it needs is all here, including the
-- one-run-per-timesheet UNIQUE guard.
--
--   • Timesheet/TimesheetLine — the actual-hours document + its per-day
--     (per project/task) lines. totalHours denormalizes Σ lines at every
--     write (F1.1 read-honesty); payrollRunId UNIQUE = consumable by
--     exactly one run, the idempotency anchor.
--   • Shift/ShiftAssignment — the roster master + one slot per employee
--     per day (UNIQUE = the no double-booking guard).
--   • AttendanceRecord.shiftAssignmentId — the optional back-link the
--     absence detection (assigned but unmarked = ABSENT) and the future
--     shift differentials read. NULL = unrostered / pre-G4 (additive,
--     honest).

-- CreateTable
CREATE TABLE "Timesheet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "totalHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payrollRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Timesheet_payrollRunId_key" UNIQUE ("payrollRunId"),
    CONSTRAINT "Timesheet_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimesheetLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timesheetId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "description" TEXT,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "isOvertime" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimesheetLine_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isOvernight" BOOLEAN NOT NULL DEFAULT false,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_name_key" UNIQUE ("name")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "rosterDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftAssignment_employeeId_rosterDate_key" UNIQUE ("employeeId", "rosterDate"),
    CONSTRAINT "ShiftAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShiftAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Timesheet_employeeId_periodStart_idx" ON "Timesheet"("employeeId", "periodStart");

-- CreateIndex
CREATE INDEX "Timesheet_status_idx" ON "Timesheet"("status");

-- CreateIndex
CREATE INDEX "TimesheetLine_timesheetId_idx" ON "TimesheetLine"("timesheetId");

-- CreateIndex
CREATE INDEX "TimesheetLine_workDate_idx" ON "TimesheetLine"("workDate");

-- CreateIndex
CREATE INDEX "ShiftAssignment_rosterDate_idx" ON "ShiftAssignment"("rosterDate");

-- CreateIndex
CREATE INDEX "ShiftAssignment_shiftId_idx" ON "ShiftAssignment"("shiftId");

-- AddColumn (the optional attendance back-link)
ALTER TABLE "AttendanceRecord" ADD COLUMN "shiftAssignmentId" TEXT;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_shiftAssignmentId_fkey" FOREIGN KEY ("shiftAssignmentId") REFERENCES "ShiftAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
