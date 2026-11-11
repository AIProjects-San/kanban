-- P39 (EM-16's advances half, EX-03 lite) — salary advances.
--
-- The benchmark's Employee Advance is a full claim/return doc; the plan's
-- lite scope is the salary-advance half: issue → installment recovery
-- through the PayAdjustment adapter → the FnF receivable line (loans
-- proper stay the later un-decline epic).
--
--   • SalaryAdvance — one advance issued to an employee: amount,
--     installment plan (count + start period), the recovery deduction
--     rides the P1 adapter as DEDUCTION-side RECURRING rows
--     (sourceType SALARY_ADVANCE, sourceId this row); status
--     OPEN → RECOVERED (the run that consumes the final installment
--     flips it) with the outstanding tracked on the row.
--
-- No binary storage, no claim/return combos (the benchmark's expense
-- half rides the later expenses epic).

CREATE TABLE "SalaryAdvance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currencyNote" TEXT NOT NULL DEFAULT '',
    -- OPEN → RECOVERED (the final installment's consuming run flips it).
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    -- The number of equal installments the recovery splits into.
    "installments" INTEGER NOT NULL DEFAULT 1,
    -- First recovery period ("YYYY-MM").
    "startPeriod" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "issuedById" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    -- The adapter rows this advance spawned (denormalized count for the
    -- UI; the rows themselves are the source of truth).
    "adjustmentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryAdvance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SalaryAdvance_userId_idx" ON "SalaryAdvance"("userId");
CREATE INDEX "SalaryAdvance_status_idx" ON "SalaryAdvance"("status");
