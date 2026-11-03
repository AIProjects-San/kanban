-- Production-readiness audit, PR-16 — secondary indexes on hot query paths
-- that previously had none (or only a prefix):
--
--   CalendarEvent.date                       — dashboard "upcoming events"
--                                             window (date >= today, ORDER BY
--                                             date) + ICS export ordering.
--   Reminder.ownerId                         — dashboard widget filter
--                                             (ownerId = me OR null).
--   Notification[recipientUserId, createdAt] — dashboard feed: recipient = me
--                                             OR broadcast, ORDER BY createdAt
--                                             DESC on every page load.
--   Message.createdAt                        — dashboard inbox ordering.
--   AuditLog[entityType, entityId]           — entity-history panel filters on
--                                             the pair; the single-column
--                                             entityType index left entityId
--                                             discrimination to a scan.
--   PasswordResetToken.expiresAt            — daily maintenance purge deletes
--                                             by expiresAt.
--
-- All statements are provider-neutral (CREATE INDEX works identically on
-- PostgreSQL and SQLite, per the dual-schema strategy in ADR-008).

-- CreateIndex
CREATE INDEX "CalendarEvent_date_idx" ON "CalendarEvent"("date");

-- CreateIndex
CREATE INDEX "Reminder_ownerId_idx" ON "Reminder"("ownerId");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
