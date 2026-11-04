-- R4 — joining formalities: configurable document checklist + BGV records.

CREATE TABLE "DocumentTypeConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTypeConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentTypeConfig_key_key" ON "DocumentTypeConfig"("key");

CREATE TABLE "CandidateDocument" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "docTypeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "fileRef" TEXT NOT NULL DEFAULT '',
    "remarks" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "verifiedById" TEXT NOT NULL DEFAULT '',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateDocument_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CandidateDocument_candidateId_docTypeKey_key"
    ON "CandidateDocument"("candidateId", "docTypeKey");
CREATE INDEX "CandidateDocument_candidateId_idx" ON "CandidateDocument"("candidateId");
CREATE INDEX "CandidateDocument_status_idx" ON "CandidateDocument"("status");

CREATE TABLE "BackgroundCheck" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "reportRef" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "initiatedById" TEXT NOT NULL DEFAULT '',
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundCheck_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "BackgroundCheck_candidateId_idx" ON "BackgroundCheck"("candidateId");
CREATE INDEX "BackgroundCheck_status_idx" ON "BackgroundCheck"("status");
