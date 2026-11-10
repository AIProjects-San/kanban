-- P23 (PR-03) — the workspace default package flag on SalaryStructure.
--
-- The benchmark's Salary Structure carries the is_active/is_default pair;
-- its is_default is a hidden, machinery-set, functionally dead checkbox at
-- the pin. Fernly gives the flag a real duty instead: at most ONE
-- structure workspace-wide carries isDefault (saving one clears the
-- previous — atomic), and the structure editor PREFILLS new structures
-- from its components (the hard-coded basic-only prefill becomes data).
-- Not employment state: a retired default still prefills — the badge says
-- "Default package", never "current pay". Default false = zero behavior
-- change for every existing row.

ALTER TABLE "SalaryStructure" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
