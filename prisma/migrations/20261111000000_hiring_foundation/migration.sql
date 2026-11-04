-- Recruitment module R1 — hiring foundation (docs/RECRUITMENT_MODULE_PLAN.md).
-- Additive only: three new tables; the sole FK (CandidateStage.candidateId)
-- cascades so deleting a candidate removes its stage timeline.

CREATE TABLE "HiringStageConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "stageType" TEXT NOT NULL DEFAULT 'CUSTOM',
    "ownerRole" TEXT NOT NULL DEFAULT 'HR',
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HiringStageConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HiringStageConfig_key_key" ON "HiringStageConfig"("key");

CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "position" TEXT NOT NULL DEFAULT '',
    "department" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "resumeUrl" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdById" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Candidate_email_key" ON "Candidate"("email");
CREATE INDEX "Candidate_status_idx" ON "Candidate"("status");
CREATE INDEX "Candidate_createdAt_idx" ON "Candidate"("createdAt");
CREATE INDEX "Candidate_userId_idx" ON "Candidate"("userId");

CREATE TABLE "CandidateStage" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "stageType" TEXT NOT NULL DEFAULT 'CUSTOM',
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "remarks" TEXT NOT NULL DEFAULT '',
    "rating" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateStage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CandidateStage_candidateId_stageKey_key" ON "CandidateStage"("candidateId", "stageKey");
CREATE INDEX "CandidateStage_candidateId_idx" ON "CandidateStage"("candidateId");
CREATE INDEX "CandidateStage_ownerUserId_idx" ON "CandidateStage"("ownerUserId");
CREATE INDEX "CandidateStage_status_idx" ON "CandidateStage"("status");

ALTER TABLE "CandidateStage" ADD CONSTRAINT "CandidateStage_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
