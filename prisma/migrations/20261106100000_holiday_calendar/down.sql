-- F1.1 down: drop the holiday calendar and the denormalized working-day
-- denominator. LeaveRequest.days / payslip lines are denormalized snapshots —
-- nothing re-derives from this table, so the drop is behavior-safe (requests
-- keep their stored day counts; LOP math falls back to calendar length).

DROP INDEX "HolidayCalendarEntry_kind_idx";
DROP INDEX "HolidayCalendarEntry_date_key";
DROP TABLE "HolidayCalendarEntry";

ALTER TABLE "PayrollRun" DROP COLUMN "workingDays";
