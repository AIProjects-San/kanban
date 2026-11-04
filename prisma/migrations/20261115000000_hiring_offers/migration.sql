-- R5 — offer builder: per-role templates + per-candidate offer records.
-- R6 columns (token/signature) land here too so that milestone ships
-- without another migration.

CREATE TABLE "OfferTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "components" TEXT NOT NULL DEFAULT '[]',
    "benefits" TEXT NOT NULL DEFAULT '[]',
    "letterTemplate" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OfferTemplate_key_key" ON "OfferTemplate"("key");

CREATE TABLE "OfferRecord" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateLabel" TEXT NOT NULL DEFAULT '',
    "components" TEXT NOT NULL DEFAULT '[]',
    "benefits" TEXT NOT NULL DEFAULT '[]',
    "letterText" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "token" TEXT NOT NULL DEFAULT '',
    "tokenExpiresAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedName" TEXT NOT NULL DEFAULT '',
    "signedIp" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferRecord_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OfferRecord" ADD CONSTRAINT "OfferRecord_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OfferRecord_candidateId_idx" ON "OfferRecord"("candidateId");
CREATE INDEX "OfferRecord_status_idx" ON "OfferRecord"("status");
