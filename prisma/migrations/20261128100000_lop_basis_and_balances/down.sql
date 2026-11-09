-- Down: drop the two P17 knobs. Both default to the pre-P17 semantics
-- (HYBRID = leave-wins; balances hidden), so the drop is lossless.

ALTER TABLE "Workspace" DROP COLUMN "showLeaveBalancesOnSlip";
ALTER TABLE "Workspace" DROP COLUMN "lopBasisMode";
