-- P33 (EM-06/EM-01/EM-B02) — the structured property history table +
-- the retirement-age display knob.
--
-- EmployeePropertyHistory: ONE row per changed employment property, written
-- only by the guarded applyEmploymentChange action inside its transaction
-- (the promotion/transfer writer). The generic AuditLog stays the free-form
-- record; this table is the machine-readable diff the benchmark's Employee
-- Property History child inspires (property / current / new, plus the
-- effective date and the change's kind). Additive: no existing table's
-- behavior changes, no data backfill (pre-P33 changes stay audit-only —
-- honest history starts at the first structured change).
--
-- Workspace.retirementAge: NULL = not configured (the pre-P33 silence); when
-- set, the directory profile modal projects retirement from birthDate + age.

CREATE TABLE "EmployeePropertyHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "currentValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'PROMOTION',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeePropertyHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeePropertyHistory_userId_effectiveAt_idx" ON "EmployeePropertyHistory"("userId", "effectiveAt");
CREATE INDEX "EmployeePropertyHistory_userId_createdAt_idx" ON "EmployeePropertyHistory"("userId", "createdAt");

ALTER TABLE "Workspace" ADD COLUMN "retirementAge" INTEGER;
