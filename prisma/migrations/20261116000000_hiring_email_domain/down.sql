-- R6 rollback.
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "hiringEmailDomain";

DROP INDEX IF EXISTS "OfferRecord_token_key";
ALTER TABLE "OfferRecord" ALTER COLUMN "token" SET NOT NULL;
ALTER TABLE "OfferRecord" ALTER COLUMN "token" SET DEFAULT '';
