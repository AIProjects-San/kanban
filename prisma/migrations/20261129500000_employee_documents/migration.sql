-- P36 (EM-21, EM-B08) — employee identification documents.
--
-- The benchmark's Identification Document Type is a doc-type master FOR
-- EMPLOYEE identification; Fernly's DocumentTypeConfig was CANDIDATE-side
-- only. This migration gives the master its scope axis and adds the
-- EmployeeDocument lifecycle row.
--
--   • DocumentTypeConfig.scope — 'CANDIDATE' (the joining-formalities
--     checklist, every pre-P36 row) | 'EMPLOYEE' (identification types:
--     passport, visa, tax number…). The JOINING GATE keeps applying
--     CANDIDATE-scope mandatory types only — an identification type never
--     blocks a join (the gate-applicability rule).
--   • EmployeeDocument — one document being collected from one employee:
--     REQUESTED → RECEIVED → VERIFIED | REJECTED (a re-request after a
--     rejection resets the row), unique per (userId, docTypeKey), label
--     snapshotted at request time so type renames never orphan history.
--     No binary storage in v1 — fileRef is a reference, the
--     CandidateDocument convention.

ALTER TABLE "DocumentTypeConfig" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'CANDIDATE';
CREATE INDEX "DocumentTypeConfig_scope_idx" ON "DocumentTypeConfig"("scope");

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
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

    CONSTRAINT "EmployeeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_userId_docTypeKey_key" ON "EmployeeDocument"("userId", "docTypeKey");
CREATE INDEX "EmployeeDocument_userId_idx" ON "EmployeeDocument"("userId");
CREATE INDEX "EmployeeDocument_status_idx" ON "EmployeeDocument"("status");
