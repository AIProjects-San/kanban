-- HR Module feature 3 — performance reviews (docs/HR_MODULE_PLAN.md §6).
-- Additive only: one new table, no existing table touched.

CREATE TABLE "PerformanceReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "selfAssessment" TEXT NOT NULL DEFAULT '',
    "selfRating" INTEGER,
    "managerComment" TEXT NOT NULL DEFAULT '',
    "managerRating" INTEGER,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PerformanceReview_userId_idx" ON "PerformanceReview"("userId");
CREATE INDEX "PerformanceReview_status_idx" ON "PerformanceReview"("status");
CREATE INDEX "PerformanceReview_createdAt_idx" ON "PerformanceReview"("createdAt");
