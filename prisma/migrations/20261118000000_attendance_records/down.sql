-- F1.3 down: drop the attendance table. Nothing derives from it yet — F1.4
-- (attendance→LOP) is not built; leave days and payroll LOP amounts are
-- denormalized snapshots on their own rows, so the drop is behavior-safe.

DROP INDEX "AttendanceRecord_status_idx";
DROP INDEX "AttendanceRecord_date_idx";
DROP INDEX "AttendanceRecord_userId_date_key";
DROP TABLE "AttendanceRecord";
