-- R5 — offer builder rollback.
DROP INDEX IF EXISTS "OfferRecord_status_idx";
DROP INDEX IF EXISTS "OfferRecord_candidateId_idx";
DROP TABLE IF EXISTS "OfferRecord";
DROP INDEX IF EXISTS "OfferTemplate_key_key";
DROP TABLE IF EXISTS "OfferTemplate";
