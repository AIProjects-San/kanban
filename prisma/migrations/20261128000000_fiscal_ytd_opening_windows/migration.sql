-- P16 (PR-11 + PR-04) — fiscal-year YTD basis + SSA opening balances +
-- component effective windows on the catalog.
--
-- Workspace.fiscalYearStartMonth: 1 = calendar year = the pre-P16 YTD
-- semantics byte-for-byte (additive, zero behavior change); e.g. 4 =
-- April–March. The aggregates kernel resets YTD at the fiscal boundary.
--
-- SalaryComponent.effectiveFrom/effectiveTo: optional catalog validity
-- window (null = unbounded = the default). The structure editor badges
-- out-of-window rows; saveSalaryStructure refuses them for the structure's
-- effectiveFrom. Existing structures keep their snapshot copies.
--
-- SalaryStructure.openingYtd: optional component-keyed YTD opening rows
-- ([{key, label, side, amount}]) seeding the fiscal year containing the
-- structure's effectiveFrom in the read-time aggregates; null = none.

ALTER TABLE "Workspace" ADD COLUMN "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SalaryComponent" ADD COLUMN "effectiveFrom" TIMESTAMP;
ALTER TABLE "SalaryComponent" ADD COLUMN "effectiveTo" TIMESTAMP;
ALTER TABLE "SalaryStructure" ADD COLUMN "openingYtd" JSONB;
