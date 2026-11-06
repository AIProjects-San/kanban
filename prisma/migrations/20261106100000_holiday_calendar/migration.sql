-- F1.1 — workspace holiday calendar (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
-- One new table + one additive column on PayrollRun; nothing else is touched.
--
-- HolidayCalendarEntry: one row per date (unique). Any entry removes the date
-- from working-day counting (isHalfDay counts 0.5); kind (PUBLIC/WEEKLY_OFF)
-- is labeling for the admin UI. Dates are UTC-midnight date-only values —
-- the LeaveRequest.startDate convention.
--
-- PayrollRun.workingDays: denormalized at run creation from the calendar
-- (Mon–Fri minus holiday entries; an empty calendar yields the plain Mon–Fri
-- count). 0 = pre-F1.1 run — readers fall back to the calendar length of
-- the month.

CREATE TABLE "HolidayCalendarEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "isHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HolidayCalendarEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HolidayCalendarEntry_date_key" ON "HolidayCalendarEntry"("date");
CREATE INDEX "HolidayCalendarEntry_kind_idx" ON "HolidayCalendarEntry"("kind");

ALTER TABLE "PayrollRun" ADD COLUMN "workingDays" INTEGER NOT NULL DEFAULT 0;
