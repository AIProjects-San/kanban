-- R3 — MailOutbox: auditable outbox for every candidate-facing email.
-- Rows are written QUEUED before the send attempt, then resolved to
-- SENT / SKIPPED / FAILED. Candidate deletion keeps the history (SetNull).

CREATE TABLE "MailOutbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "candidateId" TEXT,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "sentById" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailOutbox_pkey" PRIMARY KEY ("id")
);

-- Nullable candidate link: SetNull on delete keeps the email history.
ALTER TABLE "MailOutbox" ADD CONSTRAINT "MailOutbox_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MailOutbox_createdAt_idx" ON "MailOutbox"("createdAt");
CREATE INDEX "MailOutbox_candidateId_idx" ON "MailOutbox"("candidateId");
CREATE INDEX "MailOutbox_status_idx" ON "MailOutbox"("status");
