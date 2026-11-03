-- Auth migration Phase 1 (PR-48, docs/AUTH_MIGRATION_PLAN.md §5) — Better
-- Auth 1.7 table set, added alongside the existing User row (mapped, not
-- duplicated). Inert while NEXT_PUBLIC_AUTH_STACK=nextauth; they back the
-- parallel /api/auth-better/* stack and become the primary session store at
-- cutover.
--
-- User gains the two core columns the 1.7 adapter always selects:
--   emailVerified (inert — the workspace has no email-verification gate)
--   image         (unused — avatars are colors)
-- Credentials themselves are NOT moved: User.passwordHash stays the single
-- source of truth; the sign-in bridge syncs credential Account rows lazily
-- (spike finding F3).

-- Better Auth core user fields on the existing table.
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "image" TEXT;

-- DB-backed sessions (replaces the v4 7-day JWT at cutover; same 7-day
-- expiry, revocation becomes an immediate row delete).
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- Unique index backing session-token lookups.
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
-- Expiry-sweep index (prune job / adapter cleanup scans by expiresAt).
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- 1.7 credential/OAuth account rows. For this workspace only
-- providerId "credential" rows exist: accountId = user id, password =
-- mirror of User.passwordHash kept fresh by the sign-in bridge.
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- One row per (provider, account) — the adapter upserts on this pair.
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- Verification tokens (email verification / password reset internals of
-- Better Auth). Retained for completeness of the 1.7 table contract even
-- though the app's own reset flow keeps using PasswordResetToken.
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- FKs with cascade: hard-deleting a user removes their sessions/accounts
-- (the app itself soft-deletes — see L-P0-14 — so this fires only on the
-- admin hard-delete path).
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
