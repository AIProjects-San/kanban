-- Down: drop the P16 columns. All three are additive reads with
-- zero-behavior defaults (fiscalYearStartMonth 1 = calendar year; null
-- windows = unbounded; null openingYtd = no opening), so the drop is
-- lossless for every pre-P16 behavior.

ALTER TABLE "SalaryStructure" DROP COLUMN "openingYtd";
ALTER TABLE "SalaryComponent" DROP COLUMN "effectiveTo";
ALTER TABLE "SalaryComponent" DROP COLUMN "effectiveFrom";
ALTER TABLE "Workspace" DROP COLUMN "fiscalYearStartMonth";
