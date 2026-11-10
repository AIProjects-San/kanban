-- P23 (PR-03) — rollback of the default package flag. Lossless: dropping
-- the column loses only which structure was marked default (a prefill
-- pointer, never money, never employment state).

ALTER TABLE "SalaryStructure" DROP COLUMN "isDefault";
