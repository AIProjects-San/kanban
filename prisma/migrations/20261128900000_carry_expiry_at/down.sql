-- P29 — rollback of the per-row CARRY expiry dates. Lossless in the house
-- sense: every other column and row survives untouched; dropping the
-- nullable column only forgets the frozen lapse days (a re-migration
-- re-stamps them at the next rollover). Pre-P29 lapse semantics are
-- restored exactly — the policy knob's aggregate clock governs every row.

ALTER TABLE "LeaveLedgerEntry" DROP COLUMN "expiryAt";
