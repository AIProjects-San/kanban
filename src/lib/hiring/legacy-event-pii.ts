// ---------------------------------------------------------------------------
// R-P0-8 (REVIEW_TRIAGE §7, pre-check C scope addition) — one-time
// migration core: redact candidate PII from LEGACY stored calendar events.
//
// Context: before R-P0-4, the interview writer stored
//   title:       `Interview: ${fullName} — ${stage.label}`
//   description: `${position} · ${email}`
// on the shared, workspace-wide calendar. R-P0-4 stops the writer and adds
// an export-side renderer defense; THIS module cleans the stored rows so
// every reader of the title field — the dashboard feed (dashboard.ts:188,
// deliberately untouched), the calendar grid, future ICS wiring — renders
// PII-free data instead of relying on the defense layer.
//
// Matching (deterministic, no collateral):
//   1. STRUCTURAL — a CandidateStage linked via eventId reconstructs exactly
//      what the new writer would store: `Interview — ${stage.label}` /
//      `${position} · stage ${stage.id}`.
//   2. FORMAT — a title matching the legacy writer's deterministic shape
//      (`Interview: <name> — <label>`) keeps only the label part. This works
//      even for deleted candidates (no name list needed) and never matches
//      anything else: arbitrary text containing a person's name is NOT
//      touched (substring name matching would redact unrelated events).
//   3. EMAIL — a description (or title) containing an email is replaced
//      whole: partial scrubbing of free text is unreliable, and the legacy
//      description format carried the candidate address.
//
// Idempotent by fixed point: redacted output matches none of the patterns
// (titles start `Interview — `, descriptions carry no emails), and updates
// are only written when before ≠ after — a second run is a no-op.
//
// Auditability: every redaction writes one audit row INSIDE the same
// transaction (logAuditOn discipline). The audit row carries NO PII — the
// entity label is the redacted title, the detail names the reason. Original
// values are preserved in a pre-migration backup (the caller's onPlan
// callback receives the full plan before anything is written) so the
// migration is reversible by restore.
// ---------------------------------------------------------------------------

import { logAuditOn, type AuditEntry } from "@/lib/audit/audit";
import type { AuditAction } from "@/lib/audit/audit-meta";

/** The action the migration's audit rows use (registered in audit-meta). */
export const LEGACY_EVENT_PII_AUDIT_ACTION: AuditAction = "hiring.event_pii_redacted";

/** The legacy writer's title shape: `Interview: <name> — <stage label>`. */
const LEGACY_INTERVIEW_TITLE_RE = /^Interview:\s(.+?)\s—\s(.+)$/;

/** Email-shaped substring — the legacy description carried the candidate
 * address (`${position} · ${email}`). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** What the migration needs to know about a candidate. */
export interface CandidatePiiRow {
  id: string;
  fullName: string;
  email: string;
  position: string;
}

/** A CandidateStage row linked to its candidate (the structural key). */
export interface StageLinkRow {
  eventId: string | null;
  label: string;
  id: string;
  candidate: { id: string; fullName: string; email: string; position: string } | null;
}

/** A stored calendar event (only the fields the migration touches). */
export interface LegacyEventRow {
  id: string;
  title: string;
  description: string;
  /** Presentational only — never redacted (the writer stored a department
   * key, not PII; keeping the diff minimal is the point). */
  location?: string;
}

/** One planned redaction. */
export interface PiiRedactionPlanItem {
  eventId: string;
  before: { title: string; description: string };
  after: { title: string; description: string };
  /** Which matching layer fired — recorded (PII-free) in the audit row. */
  reason: "stage-linked reconstruction" | "legacy title format" | "email in field";
}

/** The migration's actor — a system identity, never a real user: the
 * redaction is a compliance action, not a person's edit. */
export const PII_MIGRATION_ACTOR = {
  userId: "system",
  name: "System (legacy PII migration)",
  role: "SYSTEM",
} as const;

/** The minimal Prisma surface the migration needs (real client or a
 * transaction client in tests). */
export interface PiiMigrationClient {
  candidate: { findMany: (a: unknown) => Promise<CandidatePiiRow[]> };
  candidateStage: { findMany: (a: unknown) => Promise<StageLinkRow[]> };
  calendarEvent: { findMany: (a: unknown) => Promise<LegacyEventRow[]> };
  $transaction: (fn: (tx: {
    calendarEvent: { update: (a: unknown) => Promise<unknown> };
    auditLog: { create: (a: unknown) => Promise<unknown> };
  }) => Promise<void>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Pure kernel.
// ---------------------------------------------------------------------------

/** Redact ONE event against the candidate index + stage links. Returns the
 * after-values (identical to the input when nothing matches). */
export function redactLegacyEvent(
  event: LegacyEventRow,
  candidatesByEmail: Map<string, CandidatePiiRow>,
  stageByEventId: Map<string, StageLinkRow>,
): { title: string; description: string; reason: PiiRedactionPlanItem["reason"] | null } {
  // Layer 1 — structural: the stage row links back to this event, so the
  // exact new-writer shape is reconstructable.
  const stage = event.id ? stageByEventId.get(event.id) : undefined;
  if (stage?.candidate) {
    const after = {
      title: `Interview — ${stage.label}`,
      description: `${stage.candidate.position || "Position n/a"} · stage ${stage.id}`,
    };
    if (after.title !== event.title || after.description !== event.description) {
      return { ...after, reason: "stage-linked reconstruction" };
    }
    return { title: event.title, description: event.description, reason: null };
  }

  let title = event.title;
  let description = event.description;
  let reason: PiiRedactionPlanItem["reason"] | null = null;

  // Layer 2 — the legacy title format: keep the label, drop the name. Works
  // for deleted candidates too; touches nothing that isn't the format.
  const m = LEGACY_INTERVIEW_TITLE_RE.exec(event.title);
  if (m) {
    title = `Interview — ${m[2]}`;
    reason = "legacy title format";
  } else if (EMAIL_RE.test(event.title)) {
    title = "Event — details redacted";
    reason = "email in field";
  }

  // Layer 3 — an email in the description: replace with the position when
  // the candidate is known (the new-writer description shape), else drop.
  if (EMAIL_RE.test(event.description)) {
    const email = EMAIL_RE.exec(event.description)?.[0]?.toLowerCase() ?? "";
    const candidate = candidatesByEmail.get(email);
    description = candidate ? (candidate.position || "Position n/a") : "";
    if (reason === null) reason = "email in field";
  }

  if (reason === null) return { title: event.title, description: event.description, reason: null };
  return { title, description, reason };
}

// ---------------------------------------------------------------------------
// Migration core: plan (pure read) → apply (one transaction, audited).
// ---------------------------------------------------------------------------

export interface PiiMigrationResult {
  /** Events scanned. */
  scanned: number;
  /** Events redacted (updates applied + audit rows written). */
  redacted: number;
}

export interface PiiMigrationOptions {
  /** Receives the full plan BEFORE anything is written — the caller's
   * pre-migration backup hook (reversibility requirement). */
  onPlan?: (plan: PiiRedactionPlanItem[]) => Promise<void> | void;
}

/** Read phase: build the redaction plan + the scan count. Pure with
 * respect to writes. */
export async function planLegacyEventPiiRedaction(
  db: PiiMigrationClient,
): Promise<{ scanned: number; plan: PiiRedactionPlanItem[] }> {
  const [candidates, stages, events] = await Promise.all([
    db.candidate.findMany({ select: { id: true, fullName: true, email: true, position: true } }),
    db.candidateStage.findMany({
      where: { eventId: { not: null } },
      select: {
        id: true, eventId: true, label: true,
        candidate: { select: { id: true, fullName: true, email: true, position: true } },
      },
    }),
    db.calendarEvent.findMany({ select: { id: true, title: true, description: true } }),
  ]);

  const candidatesByEmail = new Map(
    candidates.map((c) => [c.email.toLowerCase(), c] as const),
  );
  const stageByEventId = new Map(
    stages.filter((s) => s.eventId !== null).map((s) => [s.eventId as string, s] as const),
  );

  const plan: PiiRedactionPlanItem[] = [];
  for (const e of events) {
    const r = redactLegacyEvent(e, candidatesByEmail, stageByEventId);
    if (r.reason !== null) {
      plan.push({
        eventId: e.id,
        before: { title: e.title, description: e.description },
        after: { title: r.title, description: r.description },
        reason: r.reason,
      });
    }
  }
  return { scanned: events.length, plan };
}

/** Apply phase: updates + audit rows in ONE transaction. Audit rows carry
 * no PII (the redacted title is the label; the detail names the reason).
 * The tx cast is structural: the real Prisma transaction client satisfies
 * logAuditOn's AuditClient; the test double provides the same two methods. */
export async function applyLegacyEventPiiRedaction(
  db: PiiMigrationClient,
  plan: PiiRedactionPlanItem[],
  actor: AuditEntry["actor"],
): Promise<void> {
  if (plan.length === 0) return;
  await db.$transaction(async (tx) => {
    const auditClient = tx as unknown as Parameters<typeof logAuditOn>[0];
    for (const item of plan) {
      await tx.calendarEvent.update({
        where: { id: item.eventId },
        data: { title: item.after.title, description: item.after.description },
      });
      await logAuditOn(auditClient, {
        actor,
        action: LEGACY_EVENT_PII_AUDIT_ACTION,
        entityType: "CALENDAR_EVENT",
        entityId: item.eventId,
        entityLabel: item.after.title,
        detail:
          `Legacy interview PII redacted from the stored calendar event (${item.reason}) — ` +
          `the candidate identity left the title/description; the stage label is preserved. ` +
          `Original values are in the pre-migration backup recorded by this run; the event itself was not deleted.`,
      });
    }
  });
}

/** The one-call migration: plan → backup hook → apply. Re-running is a
 * no-op by the fixed-point property (redacted rows match no pattern). */
export async function migrateLegacyEventPii(
  db: PiiMigrationClient,
  actor: AuditEntry["actor"] = PII_MIGRATION_ACTOR,
  opts?: PiiMigrationOptions,
): Promise<PiiMigrationResult> {
  const { scanned, plan } = await planLegacyEventPiiRedaction(db);
  await opts?.onPlan?.(plan);
  await applyLegacyEventPiiRedaction(db, plan, actor);
  return { scanned, redacted: plan.length };
}
