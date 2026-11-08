-- P2 down: drop the encashment table + the policy knobs. Reversibility
-- note (ADR-008): dropping LeaveEncashment loses the encashment audit
-- trail (which days were sold when) and the PAID back-links; the ledger
-- CONSUME rows and every payslip line are snapshots and survive intact.

DROP INDEX IF EXISTS "LeaveEncashment_status_idx";
DROP INDEX IF EXISTS "LeaveEncashment_userId_status_idx";
DROP TABLE IF EXISTS "LeaveEncashment";
ALTER TABLE "LeavePolicy" DROP COLUMN "nonEncashableDays";
ALTER TABLE "LeavePolicy" DROP COLUMN "maxEncashableDays";
ALTER TABLE "LeavePolicy" DROP COLUMN "encashable";
