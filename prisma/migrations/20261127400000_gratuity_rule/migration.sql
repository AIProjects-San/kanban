-- P7 (PR-20/PR-21, F3.3) — the gratuity slab engine
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 7).
--
-- Additive: two new tables, no column touched. GratuityRule is the
-- workspace singleton (findFirst read; enabled defaults OFF so nothing
-- changes until HR configures it) and GratuitySlab holds the years→fraction
-- bands the FnF gratuity line walks. Pure config data — the computation
-- lives in lib/gratuity.ts and the line lands on the LIVE full-and-final
-- statement only, so settled statements never move.

CREATE TABLE "GratuityRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "averagingMonths" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "GratuitySlab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromYears" INTEGER NOT NULL,
    "toYears" INTEGER,
    "fraction" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "GratuitySlab_fromYears_key" ON "GratuitySlab"("fromYears");
