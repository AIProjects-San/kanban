-- HR Module feature 4 — onboarding (docs/HR_MODULE_PLAN.md §7).
-- Additive only: two new tables with a cascade FK between them.

CREATE TABLE "OnboardingChecklist" (
    "id" TEXT NOT NULL,
    "newHireId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingChecklist_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingChecklist_newHireId_idx" ON "OnboardingChecklist"("newHireId");
CREATE INDEX "OnboardingChecklist_createdAt_idx" ON "OnboardingChecklist"("createdAt");

CREATE TABLE "OnboardingTask" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assigneeId" TEXT,
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 7,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingTask_checklistId_idx" ON "OnboardingTask"("checklistId");
CREATE INDEX "OnboardingTask_assigneeId_idx" ON "OnboardingTask"("assigneeId");

ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "OnboardingChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
