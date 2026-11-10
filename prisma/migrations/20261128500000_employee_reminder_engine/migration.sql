-- P25 (PL-02/EM-23/EM-J01–03) — the engagement reminder engine's schema.
--
-- Three additive pieces, zero behavior change until the daily cron route
-- actually runs (a workspace without the scheduler never writes a row):
--   1. EmployeeProfile.birthDate — the birthday engine's input (nullable,
--      date-only semantics; HR-owned like hireDate);
--   2. Notification.sourceKey — the deterministic dedup key for scheduled
--      digest notifications (unique; createMany skipDuplicates makes the
--      daily job idempotent the same way ledger sourceIds do for the
--      leave-allocation job);
--   3. Workspace switches — the three in-app digests (default ON, the
--      benchmark's own default; they only fire via the cron route), the
--      holiday days-ahead knob (default 7), and the opt-in email rail
--      (default OFF = the F-R17 zero-mail posture).

ALTER TABLE "EmployeeProfile" ADD COLUMN "birthDate" TIMESTAMP;

ALTER TABLE "Notification" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "Notification_sourceKey_key" ON "Notification"("sourceKey");

ALTER TABLE "Workspace" ADD COLUMN "remindBirthdays" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Workspace" ADD COLUMN "remindAnniversaries" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Workspace" ADD COLUMN "remindHolidays" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Workspace" ADD COLUMN "holidayReminderDaysAhead" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Workspace" ADD COLUMN "emailEngagementReminders" BOOLEAN NOT NULL DEFAULT false;
