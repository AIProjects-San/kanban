-- Phase 1B (G8) — effective-dated salary assignments: one row per
-- [fromDate, toDate) window per employee, pointing at the SalaryStructure
-- that priced it plus the effective-dated salary facts (annual base /
-- variable). Payroll runs resolve the assignment in force at the window
-- start; a revision closes the previous assignment and opens a new one
-- instead of mutating the structure in place.

-- CreateTable
CREATE TABLE "SalaryStructureAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "structureId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3),
    "base" DECIMAL(12,2) NOT NULL,
    "variable" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "SalaryStructureAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalaryStructureAssignment_employeeId_fromDate_idx" ON "SalaryStructureAssignment"("employeeId", "fromDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructureAssignment_employeeId_fromDate_key" ON "SalaryStructureAssignment"("employeeId", "fromDate");

-- AddForeignKey
ALTER TABLE "SalaryStructureAssignment" ADD CONSTRAINT "SalaryStructureAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructureAssignment" ADD CONSTRAINT "SalaryStructureAssignment_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "SalaryStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
