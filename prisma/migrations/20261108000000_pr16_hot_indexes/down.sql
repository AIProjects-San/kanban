-- Down migration for 20261108000000_pr16_hot_indexes
-- Drops the six PR-16 secondary indexes. Data-neutral: indexes hold no rows.
--
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP INDEX "CalendarEvent_date_idx";
DROP INDEX "Reminder_ownerId_idx";
DROP INDEX "Notification_recipientUserId_createdAt_idx";
DROP INDEX "Message_createdAt_idx";
DROP INDEX "AuditLog_entityType_entityId_idx";
DROP INDEX "PasswordResetToken_expiresAt_idx";
