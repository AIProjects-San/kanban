-- P28 (LV-02/LV-03) — the leave policy set master + the assignment doc's
-- schema.
--
-- Three additive tables, zero behavior change while empty: with no sets and
-- no assignments every materializer resolves the pre-P28 per-type policy
-- byte-identically (the override is undefined → the policy row passes
-- through untouched — src/lib/leave-policy-set.ts policyRowWithAnnualDays).
-- The set kernel + the entitlement override live in src/lib/leave-policy-set.ts
-- (pure, test-pinned); the CRUD/bulk actions in
-- src/server-actions/leave-policy-sets.ts; the Types & Policies tab renders
-- the master + the assignments (hr:admin).

CREATE TABLE "LeavePolicySet" (
    "id"          TEXT    NOT NULL,
    "name"        TEXT    NOT NULL,
    "description" TEXT    NOT NULL DEFAULT '',
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePolicySet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeavePolicySet_name_key" ON "LeavePolicySet"("name");

CREATE TABLE "LeavePolicySetItem" (
    "id"          TEXT    NOT NULL,
    "setId"       TEXT    NOT NULL,
    "leaveTypeId" TEXT    NOT NULL,
    "annualDays"  DOUBLE PRECISION NOT NULL DEFAULT 20,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeavePolicySetItem_pkey" PRIMARY KEY ("id")
);

-- One allocation per (set, leave type) — the benchmark's Leave Policy
-- Detail child shape.
CREATE UNIQUE INDEX "LeavePolicySetItem_setId_leaveTypeId_key" ON "LeavePolicySetItem"("setId", "leaveTypeId");
CREATE INDEX "LeavePolicySetItem_setId_idx" ON "LeavePolicySetItem"("setId");

CREATE TABLE "LeavePolicyAssignment" (
    "id"           TEXT    NOT NULL,
    "userId"       TEXT    NOT NULL,
    "setId"        TEXT    NOT NULL,
    "bucketYear"   INTEGER NOT NULL,
    "periodId"     TEXT    NOT NULL DEFAULT '',
    "assignedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT    NOT NULL,

    CONSTRAINT "LeavePolicyAssignment_pkey" PRIMARY KEY ("id")
);

-- LV-03's overlap rule: one assignment per employee per ledger bucket.
CREATE UNIQUE INDEX "LeavePolicyAssignment_userId_bucketYear_key" ON "LeavePolicyAssignment"("userId", "bucketYear");
CREATE INDEX "LeavePolicyAssignment_setId_idx" ON "LeavePolicyAssignment"("setId");
CREATE INDEX "LeavePolicyAssignment_bucketYear_idx" ON "LeavePolicyAssignment"("bucketYear");
