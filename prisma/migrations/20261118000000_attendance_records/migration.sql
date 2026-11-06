-- F1.3 — attendance records (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
-- One new table; nothing else is touched.
--
-- AttendanceRecord: one row per user per date (unique userId+date).
-- status PRESENT/ABSENT/HALF_DAY/WFH/ON_LEAVE; inTime/outTime optional
-- "HH:mm" clock strings; source MANUAL (HR/admin marking at the new
-- attendance:manage permission — ADMIN+HR), IMPORT (future bulk), or
-- DERIVED (approved leave auto-marks ON_LEAVE rows — ADR-009 virtual-event
-- precedent; cancelling that leave removes them again unless another
-- approved request still covers the date). No member self-marking
-- (decision §9.1). Dates are UTC-midnight date-only values — the
-- LeaveRequest.startDate convention.

CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "inTime" TEXT,
    "outTime" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendanceRecord_userId_date_key" ON "AttendanceRecord"("userId","date");
CREATE INDEX "AttendanceRecord_date_idx" ON "AttendanceRecord"("date");
CREATE INDEX "AttendanceRecord_status_idx" ON "AttendanceRecord"("status");
