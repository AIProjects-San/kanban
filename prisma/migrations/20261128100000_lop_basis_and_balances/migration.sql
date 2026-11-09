-- P17 (PR-B27 + PR-B25) — the proration basis switch + leave balances on
-- the payslip.
--
-- Workspace.lopBasisMode: HYBRID (default — leave-wins, the pre-P17
-- semantics byte-for-byte) | LEAVE (spans only) | ATTENDANCE (marks only).
-- Consumed by lib/lop-derivation.ts at run/slip creation.
--
-- Workspace.showLeaveBalancesOnSlip: read-time balances on the payslip
-- surfaces (default OFF).

ALTER TABLE "Workspace" ADD COLUMN "lopBasisMode" TEXT NOT NULL DEFAULT 'HYBRID';
ALTER TABLE "Workspace" ADD COLUMN "showLeaveBalancesOnSlip" BOOLEAN NOT NULL DEFAULT false;
