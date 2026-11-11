-- P30 (LV-01/LV-11) — optional leave + compensatory leave.
--
-- Additive columns (defaults = the pre-P30 behavior byte-for-byte: no type
-- is optional, no type earns comp days, no optional count cap) plus the
-- worked-holiday claim table. The comp GRANT ledger rows land through
-- src/server-actions/compensatory-leave.ts (approve-time writer, the
-- leave-encashment discipline); consumption is the normal request path.

ALTER TABLE "LeaveType" ADD COLUMN "isOptionalLeave" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeaveType" ADD COLUMN "isCompensatory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN "maxOptionalHolidaysPerYear" INTEGER;

CREATE TABLE "CompensatoryLeaveRequest" (
    "id"           TEXT    NOT NULL,
    "userId"       TEXT    NOT NULL,
    "leaveTypeId"  TEXT    NOT NULL,
    "workFromDate" TIMESTAMP(3) NOT NULL,
    "workToDate"   TIMESTAMP(3) NOT NULL,
    "days"         DOUBLE PRECISION NOT NULL,
    "reason"       TEXT    NOT NULL DEFAULT '',
    "status"       TEXT    NOT NULL DEFAULT 'PENDING',
    "decidedById"  TEXT,
    "decidedAt"    TIMESTAMP(3),
    "decisionNote" TEXT    NOT NULL DEFAULT '',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompensatoryLeaveRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompensatoryLeaveRequest_userId_status_idx" ON "CompensatoryLeaveRequest"("userId", "status");
CREATE INDEX "CompensatoryLeaveRequest_status_idx" ON "CompensatoryLeaveRequest"("status");
CREATE INDEX "CompensatoryLeaveRequest_workFromDate_workToDate_idx" ON "CompensatoryLeaveRequest"("workFromDate", "workToDate");
