-- F-R18 (S18) — interview calendar events on ONE day basis
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
--
-- The pre-S18 scheduleInterview stored the interview's CalendarEvent as
-- date = the full instant + time = the SERVER-LOCAL HH:MM of that instant,
-- while every other event writer stores date = UTC midnight of the calendar
-- day + the picked HH:MM label. The reader set splits three ways on that
-- mix (calendar grid: browser-local day of the instant; ICS export: UTC day
-- + time-as-UTC), so an interview could land on a different DAY than the
-- one picked whenever the server TZ differed from the users'.
--
-- The writer now stores the planned pair (pure planInterviewEvent kernel:
-- UTC midnight of the picked calendar day + the picked HH:MM). This
-- migration moves EXISTING interview rows onto the same basis: truncate
-- each row's date to midnight of its (UTC) calendar day. The `time` label
-- is deliberately left as-is — it already names a time-of-day on that same
-- day for UTC-server deployments (the only deployments with existing rows);
-- a SQL migration cannot reconstruct a browser wall-clock it never
-- received, and the day flip (the user-visible bug) is what needed fixing.
-- Idempotent: midnight truncates to midnight.

UPDATE "CalendarEvent"
SET "date" = date_trunc('day', "date")
WHERE "title" LIKE 'Interview: %';
