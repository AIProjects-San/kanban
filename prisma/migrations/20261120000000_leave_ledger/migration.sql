-- F1.2 — append-only leave ledger (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1; benchmark: frappe/hrms Leave Ledger Entry). New table only — the
-- LeaveBalance cache columns are untouched (the cache stays, re-synced from
-- the ledger inside every ledger-writing transaction).
--
-- Entry semantics: GRANT +entitlement (materialization), CARRY +carry-over
-- (F2.4 writer, reserved), CONSUME −days on approval / +days reversal on
-- cancel (isReversal), EXPIRE −days at year end (F2.4), ADJUST ±drift.
-- Rows are immutable — corrections are new reversal rows, never edits.
--
-- Backfill (deterministic ids 'bf-<kind>-<source row id>' so a re-run after
-- a down produces the identical set):
--   1. one GRANT row per LeaveBalance with entitled ≠ 0;
--   2. one CARRY row per LeaveBalance with carriedOver ≠ 0;
--   3. one CONSUME row per APPROVED (non-cancelled) LeaveRequest;
--   4. one ADJUST row per balance trio whose legacy `used` disagrees with
--      the days of its APPROVED requests — the drift the old mutable-cache
--      world could carry silently is made an explicit, visible ledger row.

-- CreateTable
CREATE TABLE "LeaveLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "entryType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT '',
    "sourceId" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaveLedgerEntry_userId_leaveTypeId_year_idx" ON "LeaveLedgerEntry"("userId", "leaveTypeId", "year");
CREATE INDEX "LeaveLedgerEntry_sourceType_sourceId_idx" ON "LeaveLedgerEntry"("sourceType", "sourceId");
CREATE INDEX "LeaveLedgerEntry_createdAt_idx" ON "LeaveLedgerEntry"("createdAt");

-- Backfill 1 — GRANT: the entitlement each existing cache row stands for.
INSERT INTO "LeaveLedgerEntry" ("id", "userId", "leaveTypeId", "year", "delta", "entryType", "sourceType", "sourceId", "note", "isReversal", "createdAt")
SELECT 'bf-grant-' || b."id", b."userId", b."leaveTypeId", b."year", b."entitled",
       'GRANT', 'BALANCE_IMPORT', b."id",
       'F1.2 backfill: entitlement materialized pre-ledger', false, now()
FROM "LeaveBalance" b
WHERE b."entitled" <> 0;

-- Backfill 2 — CARRY: carry-over booked on the legacy cache row.
INSERT INTO "LeaveLedgerEntry" ("id", "userId", "leaveTypeId", "year", "delta", "entryType", "sourceType", "sourceId", "note", "isReversal", "createdAt")
SELECT 'bf-carry-' || b."id", b."userId", b."leaveTypeId", b."year", b."carriedOver",
       'CARRY', 'BALANCE_IMPORT', b."id",
       'F1.2 backfill: carry-over materialized pre-ledger', false, now()
FROM "LeaveBalance" b
WHERE b."carriedOver" <> 0;

-- Backfill 3 — CONSUME: one row per APPROVED request (CANCELLED-after-
-- approval history nets to zero in live rows; the pre-F1.2 code kept
-- `used` == Σ days of APPROVED requests, so these reproduce `used` exactly).
INSERT INTO "LeaveLedgerEntry" ("id", "userId", "leaveTypeId", "year", "delta", "entryType", "sourceType", "sourceId", "note", "isReversal", "createdAt")
SELECT 'bf-consume-' || r."id", r."userId", r."leaveTypeId", EXTRACT(YEAR FROM r."startDate")::INT, -r."days",
       'CONSUME', 'LEAVE_REQUEST', r."id",
       'F1.2 backfill: consumption of an approved request', false, now()
FROM "LeaveRequest" r
WHERE r."status" = 'APPROVED';

-- Backfill 4 — ADJUST: drift reconciliation. Where the legacy `used` does
-- NOT equal the days of the user/type/year's APPROVED requests (only
-- possible through out-of-band writes — the action code held the
-- invariant), a signed ADJUST row trues the ledger to the legacy cache so
-- Σ(all deltas) == entitled + carriedOver − used, and the drift becomes an
-- explicit, auditable event instead of a silent number.
INSERT INTO "LeaveLedgerEntry" ("id", "userId", "leaveTypeId", "year", "delta", "entryType", "sourceType", "sourceId", "note", "isReversal", "createdAt")
SELECT 'bf-adjust-' || b."id", b."userId", b."leaveTypeId", b."year",
       COALESCE(a."totalDays", 0) - b."used",
       'ADJUST', 'BALANCE_IMPORT', b."id",
       'F1.2 backfill: legacy used ≠ days of APPROVED requests (drift reconciliation)', false, now()
FROM "LeaveBalance" b
LEFT JOIN (
    SELECT "userId", "leaveTypeId", EXTRACT(YEAR FROM "startDate")::INT AS "year", SUM("days") AS "totalDays"
    FROM "LeaveRequest"
    WHERE "status" = 'APPROVED'
    GROUP BY "userId", "leaveTypeId", EXTRACT(YEAR FROM "startDate")::INT
) a ON a."userId" = b."userId" AND a."leaveTypeId" = b."leaveTypeId" AND a."year" = b."year"
WHERE COALESCE(a."totalDays", 0) <> b."used";
