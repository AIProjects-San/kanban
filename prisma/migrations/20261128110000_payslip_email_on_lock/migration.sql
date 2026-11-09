-- P18 (PR-B16) — opt-in payslip email on run lock. One knob:
--
-- Workspace.emailPayslipsOnLock: when true, locking a run queues one
-- PAYSLIP outbox email per payslip (HTML summary — the mailer has no
-- attachment support, the PDF stays the download-only decision §9.2),
-- delivered best-effort outside the lock transaction. Default false =
-- the pre-P18 silence byte-for-byte.

ALTER TABLE "Workspace" ADD COLUMN "emailPayslipsOnLock" BOOLEAN NOT NULL DEFAULT false;
