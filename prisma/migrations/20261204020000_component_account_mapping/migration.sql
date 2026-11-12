-- Phase 1C (G2) — the component→account posting map. Null = the system
-- fallbacks (expense → 4000 Salaries & Wages; non-statutory deduction →
-- the 4000 expense reduction), the safe pre-1C default for every existing
-- catalog row.

-- AlterTable
ALTER TABLE "SalaryComponent" ADD COLUMN "expenseAccountId" TEXT,
ADD COLUMN "liabilityAccountId" TEXT;
