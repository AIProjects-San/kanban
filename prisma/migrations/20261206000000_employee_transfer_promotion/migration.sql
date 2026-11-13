-- P1 G6 — the Employee Transfer & Employee Promotion documents: the
-- effective-dated, approval-gated employment-change writers that sit AHEAD
-- of EmployeePropertyHistory (their EFFECTIVE transition is what writes the
-- structured property rows and the profile facts).
--
-- Shape notes (spec adapted to Fernly's data model):
--   • department / jobTitle / grade / location are STRING facts on
--     EmployeeProfile (QA-19: controlled department key, free-form title,
--     grade and location — there is intentionally no Department /
--     Designation / Grade master table), so the from/to sides carry strings,
--     not FK ids;
--   • manager refs stay plain scalars (the EmployeeProfile.leaveApproverId
--     convention) — validated at write time, no FK;
--   • the employee relation itself IS a real FK (the Phase 1B
--     SalaryStructureAssignment precedent, onDelete: Restrict — a soft-
--     deleted user's documents stay queryable);
--   • linkedSalaryAssignmentId is a plain scalar pointer at the Phase 1B
--     SalaryStructureAssignment (the promotion never mutates it — the link
--     only records that the two documents belong together).
--
-- Status graph (enforced in lib/hr/employment-documents.ts, guarded by
-- status-in-WHERE updateMany flips — the QA-16 leave discipline):
--   DRAFT → PENDING_APPROVAL → APPROVED → EFFECTIVE, any pre-EFFECTIVE
--   state → CANCELLED.

-- CreateTable
CREATE TABLE "EmployeeTransfer" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromDepartment" TEXT,
    "fromJobTitle" TEXT,
    "fromManagerId" TEXT,
    "fromLocation" TEXT,
    "toDepartment" TEXT,
    "toJobTitle" TEXT,
    "toManagerId" TEXT,
    "toLocation" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "EmployeeTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePromotion" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromJobTitle" TEXT,
    "toJobTitle" TEXT NOT NULL,
    "fromGrade" TEXT,
    "toGrade" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "linkedSalaryAssignmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "EmployeePromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeTransfer_employeeId_status_idx" ON "EmployeeTransfer"("employeeId", "status");

-- CreateIndex
CREATE INDEX "EmployeeTransfer_employeeId_effectiveDate_idx" ON "EmployeeTransfer"("employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "EmployeeTransfer_status_effectiveDate_idx" ON "EmployeeTransfer"("status", "effectiveDate");

-- CreateIndex
CREATE INDEX "EmployeePromotion_employeeId_status_idx" ON "EmployeePromotion"("employeeId", "status");

-- CreateIndex
CREATE INDEX "EmployeePromotion_employeeId_effectiveDate_idx" ON "EmployeePromotion"("employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "EmployeePromotion_status_effectiveDate_idx" ON "EmployeePromotion"("status", "effectiveDate");

-- AddForeignKey
ALTER TABLE "EmployeeTransfer" ADD CONSTRAINT "EmployeeTransfer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePromotion" ADD CONSTRAINT "EmployeePromotion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
