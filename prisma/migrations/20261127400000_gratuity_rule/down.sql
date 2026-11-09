-- P7 down: drop the gratuity config tables. Reversibility note (ADR-008):
-- pure configuration, no money rows reference it; settled FnF statements
-- froze their GRATUITY lines as JSON snapshots and survive intact.

DROP INDEX IF EXISTS "GratuitySlab_fromYears_key";
DROP TABLE IF EXISTS "GratuitySlab";
DROP TABLE IF EXISTS "GratuityRule";
