-- F2.4 down (ADR-008 discipline).
-- Reversibility notes:
--   • Every column is additive with a default; dropping them loses only the
--     strategy configuration itself (which knobs each type had chosen).
--     Ledger rows the engine wrote (GRANT/CARRY/EXPIRE with
--     sourceType 'POLICY') are ordinary ledger rows — they stay and keep
--     explaining the balances they produced, exactly like the F1.2 backfill
--     rows (sourceType 'BALANCE_IMPORT') do.
--   • After the drop, every type reads as MANUAL again: the grant-on-first-
--     use materialization path keeps working (it only needs annualDays),
--     and the guard reverts to the classic days > available form.
--   • No other table references these columns.
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "allocationStrategy";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "accrualFrequency";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "allocateOnDay";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "accrualRounding";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "accrualCap";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "grantOn";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "prorateForJoiners";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "minServiceMonths";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "accrueDuringProbation";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "allowNegative";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "negativeFloor";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "carryExpiresAfterMonths";
ALTER TABLE "LeavePolicy" DROP COLUMN IF EXISTS "countHolidaysInLeave";
