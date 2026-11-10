-- P24 (PL-01) — the notification template master.
--
-- One row per CUSTOMIZED notification event. The built-in defaults live in
-- lib/notification-template.ts (a code registry — NOTIFICATION_TEMPLATE_EVENTS);
-- a missing row (or a Reset) falls back to them byte-identically, so this
-- table starts EMPTY and every pre-P24 notification/email renders exactly
-- as before until an admin explicitly customizes an event. Additive, zero
-- behavior change by construction; the writers resolve row→default at read
-- time through the same cached config read they already do.

CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "titleTemplate" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- Unique on the event key: one override row per event (resolution is
-- row-else-default, per event, never per field).
CREATE UNIQUE INDEX "NotificationTemplate_eventKey_key" ON "NotificationTemplate"("eventKey");
