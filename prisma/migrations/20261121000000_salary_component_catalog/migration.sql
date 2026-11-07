-- F1.5 — salary component catalog (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1; benchmark: frappe/hrms Salary Component). New table only —
-- structures keep their component JSON snapshots untouched (snapshot
-- discipline), so no existing column changes.
--
-- Backfill (deterministic ids 'bf-cat-<code>' so a re-run after a down
-- produces the identical set): the catalog starts as the union of every
-- component definition already in use, in priority order:
--   1. OfferTemplate.components (the curated vocabulary — sortOrder keeps
--      the template ordering: 10 + template.sortOrder);
--   2. SalaryStructure.components (codes in live use that no template
--      defines — appended at sortOrder 500 so curated rows always sort
--      first);
--   3. OfferRecord.components (signed-offer snapshots; only codes still
--      unknown after 1+2 — the demo workspace has no signed-offer-only
--      codes, but a production DB might).
-- First sighting wins. Codes repeat across templates/structures (every
-- band defines `basic`), and a NOT EXISTS guard alone cannot dedupe rows
-- inserted by the SAME statement (they are invisible to the subquery), so
-- each source is deduped with DISTINCT ON before the guard — the first
-- template by sortOrder / earliest structure by createdAt / earliest signed
-- offer by signedAt supplies the label and suggested amount. defaultAmount
-- carries that first sighting's amount — a SUGGESTION for the picker, never
-- a rewrite of the snapshots that sourced it.

-- CreateTable
CREATE TABLE "SalaryComponent" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EARNING',
    "mode" TEXT NOT NULL DEFAULT 'FIXED',
    "defaultAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalaryComponent_code_key" ON "SalaryComponent"("code");
CREATE INDEX "SalaryComponent_isActive_idx" ON "SalaryComponent"("isActive");
CREATE INDEX "SalaryComponent_sortOrder_idx" ON "SalaryComponent"("sortOrder");

-- Backfill 1 — offer templates (curated vocabulary, template order; the
-- lowest-sortOrder template that defines a code wins the sighting).
INSERT INTO "SalaryComponent" ("id", "code", "label", "kind", "mode", "defaultAmount", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT 'bf-cat-' || d."code", d."code", d."label", d."kind", d."mode", d."defaultAmount", true, d."so", now(), now()
FROM (
    SELECT DISTINCT ON (elem->>'key')
           elem->>'key'   AS "code",
           elem->>'label' AS "label",
           elem->>'kind'  AS "kind",
           elem->>'mode'  AS "mode",
           COALESCE((elem->>'amount')::DOUBLE PRECISION, 0) AS "defaultAmount",
           10 + t."sortOrder" AS "so"
    FROM "OfferTemplate" t,
         jsonb_array_elements(t."components"::jsonb) AS elem
    WHERE elem->>'key' IS NOT NULL
    ORDER BY elem->>'key', t."sortOrder", t."createdAt"
) d
WHERE NOT EXISTS (
    SELECT 1 FROM "SalaryComponent" sc WHERE sc."code" = d."code"
);

-- Backfill 2 — live structures (codes in use that no template defines; the
-- earliest structure that uses a code wins the sighting).
INSERT INTO "SalaryComponent" ("id", "code", "label", "kind", "mode", "defaultAmount", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT 'bf-cat-' || d."code", d."code", d."label", d."kind", d."mode", d."defaultAmount", true, 500, now(), now()
FROM (
    SELECT DISTINCT ON (elem->>'key')
           elem->>'key'   AS "code",
           elem->>'label' AS "label",
           elem->>'kind'  AS "kind",
           elem->>'mode'  AS "mode",
           COALESCE((elem->>'amount')::DOUBLE PRECISION, 0) AS "defaultAmount"
    FROM "SalaryStructure" s,
         jsonb_array_elements(s."components"::jsonb) AS elem
    WHERE elem->>'key' IS NOT NULL
    ORDER BY elem->>'key', s."createdAt"
) d
WHERE NOT EXISTS (
    SELECT 1 FROM "SalaryComponent" sc WHERE sc."code" = d."code"
);

-- Backfill 3 — signed-offer snapshots (last resort; the earliest signed
-- offer wins the sighting). Demo DB: empty set.
INSERT INTO "SalaryComponent" ("id", "code", "label", "kind", "mode", "defaultAmount", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT 'bf-cat-' || d."code", d."code", d."label", d."kind", d."mode", d."defaultAmount", true, 900, now(), now()
FROM (
    SELECT DISTINCT ON (elem->>'key')
           elem->>'key'   AS "code",
           elem->>'label' AS "label",
           elem->>'kind'  AS "kind",
           elem->>'mode'  AS "mode",
           COALESCE((elem->>'amount')::DOUBLE PRECISION, 0) AS "defaultAmount"
    FROM "OfferRecord" o,
         jsonb_array_elements(o."components"::jsonb) AS elem
    WHERE elem->>'key' IS NOT NULL
    ORDER BY elem->>'key', o."signedAt"
) d
WHERE NOT EXISTS (
    SELECT 1 FROM "SalaryComponent" sc WHERE sc."code" = d."code"
);
