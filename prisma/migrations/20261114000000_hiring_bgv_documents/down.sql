-- R4 — joining formalities rollback.
DROP INDEX IF EXISTS "BackgroundCheck_status_idx";
DROP INDEX IF EXISTS "BackgroundCheck_candidateId_idx";
DROP TABLE IF EXISTS "BackgroundCheck";
DROP INDEX IF EXISTS "CandidateDocument_status_idx";
DROP INDEX IF EXISTS "CandidateDocument_candidateId_idx";
DROP INDEX IF EXISTS "CandidateDocument_candidateId_docTypeKey_key";
DROP TABLE IF EXISTS "CandidateDocument";
DROP INDEX IF EXISTS "DocumentTypeConfig_key_key";
DROP TABLE IF EXISTS "DocumentTypeConfig";
