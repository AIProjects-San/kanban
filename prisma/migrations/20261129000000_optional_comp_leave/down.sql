-- P30 (LV-01/LV-11) — down: drop the compensatory claim table and the
-- optional/comp knobs (the ledger keeps its rows; the columns/table are
-- additive and nothing else references them).

DROP TABLE IF EXISTS "CompensatoryLeaveRequest";
ALTER TABLE "LeavePolicy" DROP COLUMN "maxOptionalHolidaysPerYear";
ALTER TABLE "LeaveType" DROP COLUMN "isCompensatory";
ALTER TABLE "LeaveType" DROP COLUMN "isOptionalLeave";
