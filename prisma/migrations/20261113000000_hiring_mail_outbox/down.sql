-- R3 — MailOutbox rollback.
DROP INDEX IF EXISTS "MailOutbox_status_idx";
DROP INDEX IF EXISTS "MailOutbox_candidateId_idx";
DROP INDEX IF EXISTS "MailOutbox_createdAt_idx";
DROP TABLE IF EXISTS "MailOutbox";
