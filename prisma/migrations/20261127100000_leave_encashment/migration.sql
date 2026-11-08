-- P2 (LV-09, F2.2) — leave encashment riding the PayAdjustment adapter
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2).
--
-- Additive everywhere; the zero-behavior default is encashable = false (no
-- type sells days back until an admin opts in — same discipline as the F2.4
-- strategy knobs).
--
-- LeavePolicy gains the benchmark's encashment knobs:
--   encashable           (allow_encashment)
--   maxEncashableDays    (max_encashable_days — per-request cap)
--   nonEncashableDays    (non_encashable_days — the balance floor that can
--                         never be sold)
--
-- LeaveEncashment: the request row. PENDING → APPROVED/REJECTED by the
-- leave-approver chain; APPROVED → PAID when the consuming run locks
-- (paidRunId back-link via the adapter row's consumedRunId). Approval
-- writes the ledger CONSUME row + the ENCASHMENT PayAdjustment in ONE
-- transaction (days × daily rate, GROSS_OVER_WORKING_DAYS basis).

ALTER TABLE "LeavePolicy" ADD COLUMN "encashable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeavePolicy" ADD COLUMN "maxEncashableDays" REAL NOT NULL DEFAULT 5;
ALTER TABLE "LeavePolicy" ADD COLUMN "nonEncashableDays" REAL NOT NULL DEFAULT 5;

CREATE TABLE "LeaveEncashment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "days" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payoutPeriod" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "dailyRate" REAL NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "decidedById" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "paidRunId" TEXT NOT NULL DEFAULT '',
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "LeaveEncashment_userId_status_idx" ON "LeaveEncashment"("userId", "status");
CREATE INDEX "LeaveEncashment_status_idx" ON "LeaveEncashment"("status");
