-- P27 (LV-08) — the leave period master's schema.
--
-- One additive table, zero behavior change while empty: with no LeavePeriod
-- rows every date resolves to the implicit calendar-year window and every
-- engine path (grants, rollover, lapse, caps) is byte-identical to the
-- pre-P27 behavior. The engine itself (the pure window kernel) lives in
-- src/lib/leave-period.ts; the CRUD actions in
-- src/server-actions/leave-periods.ts; the Types & Policies tab renders the
-- master (hr:admin).

CREATE TABLE "LeavePeriod" (
    "id"        TEXT    NOT NULL,
    "name"      TEXT    NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate"   TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeavePeriod_name_key" ON "LeavePeriod"("name");
