-- Down migration for 20261030020000_password_reset_tokens
-- Reverses: CREATE TABLE PasswordResetToken + indexes + FK
--
-- ⚠️ DATA LOSS: drops the entire PasswordResetToken table. All pending
-- (unused, non-expired) password reset tokens are destroyed — users mid-
-- reset will need to request a new token. Already-used tokens are also
-- gone (audit trail for `password.reset` events lives in AuditLog, not
-- here, so audit history is unaffected).
--
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "PasswordResetToken";
