import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// R-P0-8 — the legacy interview-event PII migration (one-time, idempotent,
// audited, reversible via the onPlan backup). Sample data carries the known
// PII patterns; the assertions prove: titles/descriptions redacted, audit
// entries created (PII-free), a second run redacts nothing (fixed point),
// clean events untouched, and the dashboard-visible fields (title!) come
// out PII-free.
// ---------------------------------------------------------------------------

import {
  migrateLegacyEventPii,
  redactLegacyEvent,
  PII_MIGRATION_ACTOR,
  LEGACY_EVENT_PII_AUDIT_ACTION,
  type PiiMigrationClient,
  type PiiRedactionPlanItem,
  type CandidatePiiRow,
  type StageLinkRow,
  type LegacyEventRow,
} from "../legacy-event-pii";

// A mock Prisma-shaped client with an in-memory calendarEvent table, so
// the full plan→apply→re-plan cycle (idempotency) runs against real state.
function makeDb(seed: {
  candidates: CandidatePiiRow[];
  stages: StageLinkRow[];
  events: LegacyEventRow[];
}) {
  const state = {
    events: new Map(seed.events.map((e) => [e.id, { ...e }])),
    auditRows: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  const db: PiiMigrationClient = {
    candidate: { findMany: async () => seed.candidates },
    candidateStage: { findMany: async () => seed.stages },
    calendarEvent: { findMany: async () => [...state.events.values()] },
    $transaction: async (fn: (tx: {
      calendarEvent: { update: (a: unknown) => Promise<unknown> };
      auditLog: { create: (a: unknown) => Promise<unknown> };
    }) => Promise<void>) =>
      fn({
        calendarEvent: {
          update: async (a: unknown) => {
            const arg = a as { where: { id: string }; data: { title: string; description: string } };
            const row = state.events.get(arg.where.id);
            if (!row) throw new Error(`unknown event ${arg.where.id}`);
            state.updates.push(arg);
            Object.assign(row, arg.data);
            return row;
          },
        },
        auditLog: {
          create: async (a: unknown) => {
            state.auditRows.push(a as Record<string, unknown>);
            return a;
          },
        },
      }),
  };
  return { db, state };
}

const CANDIDATES: CandidatePiiRow[] = [
  { id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", position: "SWE" },
  { id: "cand-2", fullName: "Sam Whitaker", email: "sam@example.com", position: "Product Designer" },
];

// A stage linked to an event (the F-R6 eventId linkage) — the structural key.
const STAGES: StageLinkRow[] = [
  {
    id: "st-9",
    eventId: "evt-linked",
    label: "Interview 1 — Technical",
    candidate: { id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", position: "SWE" },
  },
];

const EVENTS: LegacyEventRow[] = [
  // The structural case: stage-linked legacy row.
  {
    id: "evt-linked",
    title: "Interview: Nadia Petrova — Interview 1 — Technical",
    description: "SWE · nadia@example.com",
  },
  // The format case: legacy title, NO stage link (pre-F-R6 row), candidate
  // still known via the email in the description.
  {
    id: "evt-unlinked",
    title: "Interview: Sam Whitaker — Phone Screen",
    description: "Product Designer · sam@example.com",
  },
  // The deleted-candidate case: legacy format, nobody matches.
  {
    id: "evt-ghost",
    title: "Interview: Former Person — Final Round",
    description: "Former role · former@example.com",
  },
  // A clean generic event — must pass through untouched.
  { id: "evt-clean", title: "Sprint planning", description: "Weekly sync" },
  // A post-R-P0-4 interview event (the new writer's shape) — already clean.
  { id: "evt-new", title: "Interview — Interview 1 — Technical", description: "SWE · stage st-9" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("R-P0-8 — redactLegacyEvent (pure kernel)", () => {
  const byEmail = new Map(CANDIDATES.map((c) => [c.email.toLowerCase(), c]));
  const stageByEventId = new Map(STAGES.filter((s) => s.eventId).map((s) => [s.eventId as string, s]));

  it("reconstructs the new-writer shape for a stage-linked legacy row", () => {
    const r = redactLegacyEvent(EVENTS[0], byEmail, stageByEventId);
    expect(r.title).toBe("Interview — Interview 1 — Technical");
    expect(r.description).toBe("SWE · stage st-9");
    expect(r.reason).toBe("stage-linked reconstruction");
  });

  it("keeps the stage label and the known candidate's position for an unlinked legacy row", () => {
    const r = redactLegacyEvent(EVENTS[1], byEmail, stageByEventId);
    expect(r.title).toBe("Interview — Phone Screen");
    expect(r.description).toBe("Product Designer");
    expect(r.reason).toBe("legacy title format");
  });

  it("redacts a deleted candidate's row (format works without a name list)", () => {
    const r = redactLegacyEvent(EVENTS[2], byEmail, stageByEventId);
    expect(r.title).toBe("Interview — Final Round");
    expect(r.description).toBe(""); // unknown email → dropped whole
  });

  it("passes clean events and already-redacted events through untouched", () => {
    expect(redactLegacyEvent(EVENTS[3], byEmail, stageByEventId).reason).toBeNull();
    expect(redactLegacyEvent(EVENTS[4], byEmail, stageByEventId).reason).toBeNull();
  });

  it("does NOT redact arbitrary text that merely contains a person's name", () => {
    const r = redactLegacyEvent(
      { id: "evt-adjacent", title: "Coffee with Sam", description: "1:1" },
      byEmail,
      stageByEventId,
    );
    expect(r.reason).toBeNull(); // no collateral — substring name matching is refused
  });
});

describe("R-P0-8 — migrateLegacyEventPii (the one-time migration)", () => {
  it("redacts the PII rows, writes one audit row per redaction (PII-free), leaves clean rows alone", async () => {
    const { db, state } = makeDb({ candidates: CANDIDATES, stages: STAGES, events: EVENTS });
    const backups: PiiRedactionPlanItem[][] = [];

    const res = await migrateLegacyEventPii(db, PII_MIGRATION_ACTOR, {
      onPlan: (plan) => {
        backups.push(plan);
      },
    });

    expect(res.scanned).toBe(5);
    expect(res.redacted).toBe(3); // linked + unlinked + ghost

    // The stored rows are PII-free but keep utility (stage label / position).
    expect(state.events.get("evt-linked")).toMatchObject({
      title: "Interview — Interview 1 — Technical",
      description: "SWE · stage st-9",
    });
    expect(state.events.get("evt-unlinked")).toMatchObject({
      title: "Interview — Phone Screen",
      description: "Product Designer",
    });
    expect(state.events.get("evt-ghost")).toMatchObject({
      title: "Interview — Final Round",
      description: "",
    });
    // Clean + already-new-format rows untouched.
    expect(state.updates.map((u) => (u as { where: { id: string } }).where.id).sort())
      .toEqual(["evt-ghost", "evt-linked", "evt-unlinked"]);

    // One audit row per redaction, on the typed action, with the system
    // actor — and NO PII anywhere in the audit row (the redacted title is
    // the label; the detail names the reason).
    expect(state.auditRows).toHaveLength(3);
    for (const createArg of state.auditRows) {
      const row = (createArg as { data: Record<string, string> }).data;
      expect(row.action).toBe(LEGACY_EVENT_PII_AUDIT_ACTION);
      expect(row.actorId).toBe("system");
      expect(row.actorName).toBe("System (legacy PII migration)");
      const flat = JSON.stringify(row);
      expect(flat).not.toContain("Nadia");
      expect(flat).not.toContain("nadia@example.com");
      expect(flat).not.toContain("Sam Whitaker");
      expect(flat).not.toContain("former@example.com");
    }

    // The backup hook received the full plan BEFORE apply — the
    // reversibility artifact (original values preserved).
    expect(backups).toHaveLength(1);
    expect(backups[0]).toHaveLength(3);
    expect(backups[0].find((p) => p.eventId === "evt-linked")?.before.title)
      .toBe("Interview: Nadia Petrova — Interview 1 — Technical");
  });

  it("is idempotent — a second run redacts nothing and writes no audit rows", async () => {
    const { db, state } = makeDb({ candidates: CANDIDATES, stages: STAGES, events: EVENTS });

    const first = await migrateLegacyEventPii(db, PII_MIGRATION_ACTOR);
    expect(first.redacted).toBe(3);

    const second = await migrateLegacyEventPii(db, PII_MIGRATION_ACTOR);
    expect(second.scanned).toBe(5);
    expect(second.redacted).toBe(0); // fixed point: nothing matches twice
    expect(state.auditRows).toHaveLength(3); // no new audit rows
    expect(state.updates).toHaveLength(3); // no re-writes

    // The event count is preserved — redaction, never deletion.
    expect(state.events.size).toBe(5);
  });

  it("runs cleanly on a workspace with no events (no backup, no audit)", async () => {
    const { db, state } = makeDb({ candidates: [], stages: [], events: [] });
    let backupCalls = 0;
    const res = await migrateLegacyEventPii(db, PII_MIGRATION_ACTOR, {
      onPlan: () => {
        backupCalls += 1;
      },
    });
    expect(res).toEqual({ scanned: 0, redacted: 0 });
    expect(backupCalls).toBe(1); // the hook still fires (empty plan = no backup file to write)
    expect(state.auditRows).toHaveLength(0);
  });
});
