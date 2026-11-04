-- R6 — deterministic employee-email domain for auto-created hires.
ALTER TABLE "Workspace" ADD COLUMN "hiringEmailDomain" TEXT NOT NULL DEFAULT 'fernly.app';

-- R6 — the signing token becomes a nullable UNIQUE column (NULL while DRAFT).
ALTER TABLE "OfferRecord" ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "OfferRecord" ALTER COLUMN "token" DROP DEFAULT;
CREATE UNIQUE INDEX "OfferRecord_token_key" ON "OfferRecord"("token");
