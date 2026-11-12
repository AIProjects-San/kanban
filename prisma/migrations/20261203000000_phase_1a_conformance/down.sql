-- Phase 1A conformance — reverse.

-- DropTable
DROP TABLE "TaxYear";

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" RENAME COLUMN "kiwiSaverEmployeeRate" TO "kiwiSaverRate";

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" RENAME COLUMN "kiwiSaverEmployerRate" TO "employerKiwiSaverRate";

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN "studentLoan",
DROP COLUMN "taxCodeSource",
DROP COLUMN "autoEnrolExemption",
DROP COLUMN "autoEnrolDueDate";

-- AlterTable
ALTER TABLE "PayrollRun" DROP COLUMN "taxYearId";

-- AlterTable
ALTER TABLE "Payslip" DROP COLUMN "taxCodeApplied",
DROP COLUMN "statutoryRuleVersion",
DROP COLUMN "employerKiwiSaverGross",
DROP COLUMN "employerEsct",
DROP COLUMN "employerKiwiSaverNet";
