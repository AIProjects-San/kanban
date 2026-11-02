-- Deep-dive review F-09 — dedicated audit retention column.
-- pruneAuditLogs previously read `auditLogLimit` (the UI display limit) as
-- its retention window in DAYS, so changing how many rows the audit page
-- shows silently changed how long audit history lives. New column:
-- auditRetentionDays (default 180, clamped to >= 30 at read time).
ALTER TABLE "Workspace" ADD COLUMN "auditRetentionDays" INTEGER NOT NULL DEFAULT 180;
