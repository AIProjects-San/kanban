-- P37 — lossless down: both tables are brand new (no rows predate the
-- migration); the free-text profile `skills` string was untouched.

DROP INDEX "EmployeeSkill_skillKey_idx";
DROP INDEX "EmployeeSkill_userId_idx";
DROP INDEX "EmployeeSkill_userId_skillKey_key";
DROP TABLE "EmployeeSkill";
DROP INDEX "Skill_sortOrder_idx";
DROP TABLE "Skill";
