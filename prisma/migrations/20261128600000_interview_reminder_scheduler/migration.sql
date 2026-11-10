-- P26 (PL-03/RJ-B18) — the interview reminder engine's schema.
--
-- Two additive Workspace switches, zero behavior change until the daily
-- cron route actually runs (a workspace without the scheduler never
-- writes a row):
--   • remindInterviews — the in-app nudge (default ON, the benchmark's
--     own default; one personal notification per interviewer per
--     same-day scheduled interview);
--   • emailInterviewReminders — the opt-in email rail (default OFF = the
--     F-R17 zero-mail posture; one outbox row per newly nudged interview).
-- The engine itself (the pure rule + the scheduled writer) lives in
-- src/lib/interview-reminders.ts; the scheduler surface (the daily
-- dispatcher + this job's standalone route) in src/app/api/cron/**.

ALTER TABLE "Workspace" ADD COLUMN "remindInterviews" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Workspace" ADD COLUMN "emailInterviewReminders" BOOLEAN NOT NULL DEFAULT false;
