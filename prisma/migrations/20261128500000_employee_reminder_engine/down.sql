-- P25 — rollback of the engagement reminder engine's schema. Lossless:
-- the birthDates admins typed and the switches' positions are lost, but
-- no business data (notifications were broadcasts; the outbox keeps its
-- rows). The Notification.sourceKey column only ever held deterministic
-- digest keys.

DROP INDEX "Notification_sourceKey_key" ON "Notification";
ALTER TABLE "Notification" DROP COLUMN "sourceKey";
ALTER TABLE "EmployeeProfile" DROP COLUMN "birthDate";
ALTER TABLE "Workspace" DROP COLUMN "remindBirthdays";
ALTER TABLE "Workspace" DROP COLUMN "remindAnniversaries";
ALTER TABLE "Workspace" DROP COLUMN "remindHolidays";
ALTER TABLE "Workspace" DROP COLUMN "holidayReminderDaysAhead";
ALTER TABLE "Workspace" DROP COLUMN "emailEngagementReminders";
