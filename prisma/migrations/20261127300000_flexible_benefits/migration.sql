-- P5 (PR-15–18, PR-B04, F3.2) — flexible benefits lite
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 5).
--
-- Additive everywhere. SalaryStructure.maxBenefits (the benchmark's
-- max_benefits cap, 0 = no cap / no benefits — zero-behavior default);
-- BenefitElection (the yearly, capped input); BenefitAccrual (the
-- append-only mini-ledger: +ACCRUAL rows at run lock, −CLAIM rows at claim
-- approval — the same ledger discipline the leave module proves).

ALTER TABLE "SalaryStructure" ADD COLUMN "maxBenefits" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "BenefitElection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "componentCode" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "annualAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "BenefitElection_userId_year_componentCode_key" ON "BenefitElection"("userId", "year", "componentCode");
CREATE INDEX "BenefitElection_userId_year_status_idx" ON "BenefitElection"("userId", "year", "status");

CREATE TABLE "BenefitAccrual" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "componentCode" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT '',
    "period" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "BenefitAccrual_userId_year_componentCode_idx" ON "BenefitAccrual"("userId", "year", "componentCode");
