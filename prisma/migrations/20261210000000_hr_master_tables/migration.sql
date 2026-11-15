-- P2.1 (ADR-022) — the HR masters: Department, Designation, Grade.
--
--   • Three new master tables. Department carries the legacy enum KEY in
--     `code` ("ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT") and
--     the human label in `name`; the EmployeeProfile string mirrors keep
--     storing the code, so every Phase 1/2 string reader (payroll
--     analytics' dimension charts, the CSV exports) is untouched.
--   • EmployeeProfile gains nullable departmentId/designationId/gradeId
--     (RESTRICT — a master with referencing employees is deactivated,
--     never deleted; the action-level guard gives the friendly error).
--   • The transfer/promotion documents gain the FK links beside their
--     from/to string snapshots (SET NULL — the snapshot survives the
--     master's deletion, the document's facts never die with it).
--   • Backfill: masters are created from the DISTINCT non-empty strings
--     already in EmployeeProfile (departments with the label mapping,
--     designations and grades by name), then every profile row is linked.
--     Deterministic and idempotent-by-unique: re-running links at most
--     what a concurrent write un-linked.

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parentId" TEXT,
    "costCenter" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_name_key" UNIQUE ("name"),
    CONSTRAINT "Department_code_key" UNIQUE ("code")
);

-- CreateTable
CREATE TABLE "Designation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "gradeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Designation_name_key" UNIQUE ("name"),
    CONSTRAINT "Designation_code_key" UNIQUE ("code")
);

-- CreateTable
CREATE TABLE "Grade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "minBase" DOUBLE PRECISION,
    "maxBase" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grade_name_key" UNIQUE ("name")
);

-- CreateIndex
CREATE INDEX "Department_parentId_idx" ON "Department"("parentId");

-- CreateIndex
CREATE INDEX "Designation_gradeId_idx" ON "Designation"("gradeId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Designation" ADD CONSTRAINT "Designation_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: the profile master links (RESTRICT — see the header).
ALTER TABLE "EmployeeProfile" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "EmployeeProfile" ADD COLUMN "designationId" TEXT;
ALTER TABLE "EmployeeProfile" ADD COLUMN "gradeId" TEXT;

-- CreateIndex
CREATE INDEX "EmployeeProfile_departmentId_idx" ON "EmployeeProfile"("departmentId");
CREATE INDEX "EmployeeProfile_designationId_idx" ON "EmployeeProfile"("designationId");
CREATE INDEX "EmployeeProfile_gradeId_idx" ON "EmployeeProfile"("gradeId");

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the document FK links beside their string snapshots.
ALTER TABLE "EmployeeTransfer" ADD COLUMN "fromDepartmentId" TEXT;
ALTER TABLE "EmployeeTransfer" ADD COLUMN "toDepartmentId" TEXT;
ALTER TABLE "EmployeePromotion" ADD COLUMN "fromDesignationId" TEXT;
ALTER TABLE "EmployeePromotion" ADD COLUMN "toDesignationId" TEXT;

-- AddForeignKey
ALTER TABLE "EmployeeTransfer" ADD CONSTRAINT "EmployeeTransfer_fromDepartmentId_fkey" FOREIGN KEY ("fromDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmployeeTransfer" ADD CONSTRAINT "EmployeeTransfer_toDepartmentId_fkey" FOREIGN KEY ("toDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmployeePromotion" ADD CONSTRAINT "EmployeePromotion_fromDesignationId_fkey" FOREIGN KEY ("fromDesignationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmployeePromotion" ADD CONSTRAINT "EmployeePromotion_toDesignationId_fkey" FOREIGN KEY ("toDesignationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill: masters from the distinct non-empty strings.
-- ---------------------------------------------------------------------------

-- Departments: the four enum keys map to their labels; anything else
-- (a workspace that wrote a raw string past the zod boundary) maps to
-- itself as BOTH name and code-less label.
INSERT INTO "Department" ("id", "name", "code", "isActive", "updatedAt")
SELECT
    'dept_' || lower(replace(d."department", ' ', '_')),
    CASE d."department"
        WHEN 'ENGINEERING' THEN 'Engineering'
        WHEN 'DESIGN' THEN 'Design'
        WHEN 'MARKETING' THEN 'Marketing'
        WHEN 'MANAGEMENT' THEN 'Management'
        ELSE d."department"
    END,
    d."department",
    true,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "department" FROM "EmployeeProfile" WHERE "department" <> ''
) AS d
WHERE NOT EXISTS (
    SELECT 1 FROM "Department" ex WHERE ex."code" = d."department"
);

-- Designations: one per distinct non-empty jobTitle, named by the string.
INSERT INTO "Designation" ("id", "name", "isActive", "updatedAt")
SELECT
    'desig_' || lower(replace(t."jobTitle", ' ', '_')),
    t."jobTitle",
    true,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "jobTitle" FROM "EmployeeProfile" WHERE "jobTitle" <> ''
) AS t
WHERE NOT EXISTS (
    SELECT 1 FROM "Designation" ex WHERE ex."name" = t."jobTitle"
);

-- Grades: one per distinct non-empty grade string; the level is a
-- deterministic placeholder (alphabetical order) HR reorders in the UI.
INSERT INTO "Grade" ("id", "name", "level", "isActive", "updatedAt")
SELECT
    'grade_' || lower(replace(g."grade", ' ', '_')),
    g."grade",
    g.seq,
    true,
    CURRENT_TIMESTAMP
FROM (
    SELECT "grade", ROW_NUMBER() OVER (ORDER BY "grade") AS seq
    FROM "EmployeeProfile" WHERE "grade" <> ''
    GROUP BY "grade"
) AS g
WHERE NOT EXISTS (
    SELECT 1 FROM "Grade" ex WHERE ex."name" = g."grade"
);

-- Link the profiles: department by code, designation and grade by name.
UPDATE "EmployeeProfile" AS ep
SET "departmentId" = d."id"
FROM "Department" AS d
WHERE ep."department" <> '' AND d."code" = ep."department" AND ep."departmentId" IS NULL;

UPDATE "EmployeeProfile" AS ep
SET "designationId" = desig."id"
FROM "Designation" AS desig
WHERE ep."jobTitle" <> '' AND desig."name" = ep."jobTitle" AND ep."designationId" IS NULL;

UPDATE "EmployeeProfile" AS ep
SET "gradeId" = gr."id"
FROM "Grade" AS gr
WHERE ep."grade" <> '' AND gr."name" = ep."grade" AND ep."gradeId" IS NULL;

-- Link the documents (the from/to string snapshots already stored).
UPDATE "EmployeeTransfer" AS t
SET "fromDepartmentId" = d."id"
FROM "Department" AS d
WHERE t."fromDepartment" IS NOT NULL AND d."code" = t."fromDepartment" AND t."fromDepartmentId" IS NULL;

UPDATE "EmployeeTransfer" AS t
SET "toDepartmentId" = d."id"
FROM "Department" AS d
WHERE t."toDepartment" IS NOT NULL AND d."code" = t."toDepartment" AND t."toDepartmentId" IS NULL;

UPDATE "EmployeePromotion" AS p
SET "fromDesignationId" = desig."id"
FROM "Designation" AS desig
WHERE p."fromJobTitle" IS NOT NULL AND desig."name" = p."fromJobTitle" AND p."fromDesignationId" IS NULL;

UPDATE "EmployeePromotion" AS p
SET "toDesignationId" = desig."id"
FROM "Designation" AS desig
WHERE p."toJobTitle" IS NOT NULL AND desig."name" = p."toJobTitle" AND p."toDesignationId" IS NULL;
