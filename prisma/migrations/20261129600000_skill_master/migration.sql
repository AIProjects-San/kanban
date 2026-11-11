-- P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps.
--
-- The benchmark's Skill master is SHARED between employee skill maps and
-- interview Expected Skill Sets; Fernly's profile carried a free-text
-- `skills` string only. This migration adds the master and the per-employee
-- map rows:
--
--   • Skill — the shared master (key, label, description, active). Rows
--     are referenced by KEY so label renames never orphan history — the
--     DocumentTypeConfig discipline.
--   • EmployeeSkill — one rated skill per employee (unique userId+skillKey,
--     rating 1–5, proficiency label derived at read). The free-text
--     `skills` string stays as the quick self-service summary; the map is
--     the structured record HR curates through the profile's Skills tab.
--
-- EM-19/PF-07: the master. EM-18: the map. The interview-round expected
-- skill sets ride the same master when the round-template epic (P41)
-- lands — the Skill.key FK is the join point.

CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_key_key" UNIQUE ("key")
);
CREATE INDEX "Skill_sortOrder_idx" ON "Skill"("sortOrder");

CREATE TABLE "EmployeeSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 3,
    "notes" TEXT NOT NULL DEFAULT '',
    "assessedById" TEXT NOT NULL DEFAULT '',
    "assessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeSkill_userId_skillKey_key" ON "EmployeeSkill"("userId", "skillKey");
CREATE INDEX "EmployeeSkill_userId_idx" ON "EmployeeSkill"("userId");
CREATE INDEX "EmployeeSkill_skillKey_idx" ON "EmployeeSkill"("skillKey");
