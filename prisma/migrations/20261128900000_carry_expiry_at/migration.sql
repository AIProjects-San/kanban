-- P29 (LV-04) — per-row CARRY expiry dates. The leave ledger's CARRY rows
-- gain the frozen lapse day the benchmark's Leave Allocation writes on its
-- new + CF parts (each with its own expiry date). Nullable and stamped
-- ONLY by the rollover writer (null = never lapses; pre-P29 rows keep the
-- policy-knob bridge the lapse phase applies). No default, no index — the
-- lapse phase reads whole buckets, never queries by expiryAt alone.

ALTER TABLE "LeaveLedgerEntry" ADD COLUMN "expiryAt" TIMESTAMP(3);
