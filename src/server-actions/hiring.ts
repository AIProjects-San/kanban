"use server";

// ---------------------------------------------------------------------------
// Recruitment module R1 — hiring server actions
// (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R1).
//
// Split: interviews → hiring-interviews.ts, formalities →
// hiring-formalities.ts, offers → hiring-offers.ts, onboarding →
// hiring-onboarding.ts. This file keeps the pipeline core (board,
// candidate CRUD, stage transitions, decisions, outbox, templates).
//
// RBAC:
//   hiring:view   — read the board + templates (ADMIN, HR, MANAGER)
//   hiring:manage — candidate CRUD, advance stages, decide (ADMIN, HR)
//   hiring:config — stage-template editor (ADMIN, HR)
//   (session-only — no permission) the member-interviewer self-service
//   surface (persona-audit P0-5 / D-04): getMyInterviews + saveScorecard
//   are scoped to the caller's OWN assigned stages via getSessionOrThrow,
//   mirroring getMyPayslips. A MEMBER who is assigned as an interviewer can
//   see their own interviews and fill their own scorecard without holding
//   hiring:view — the board, funnel, outbox and offers stay gated.
//
// Configurability contract: candidates snapshot the template at creation
// (label/stageType copied), so template edits never rewrite history. The
// per-candidate override paths are setStageStatus(SKIPPED) and
// addCandidateStage (extra custom stage for one person).
// ---------------------------------------------------------------------------
import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError, checkPermission } from "./auth-guard";
import type { CandidateT, CandidateStageT, HiringStageConfigT, MailOutboxT } from "@/lib/types";
import {
  createCandidateSchema,
  updateCandidateSchema,
  setStageStatusSchema,
  addCandidateStageSchema,
  decideCandidateSchema,
  saveStageTemplateSchema,
  deleteStageTemplateSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
// R3 — decisions & candidate email outbox.
import { composeRejectionEmail } from "@/lib/hiring/hiring-email";
import { createMailer } from "@/lib/email/mailer";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
// F-R5 — the funnel converges stale SENT offers before counting.
import { isOfferLinkExpired } from "@/lib/hiring/offer-lifecycle";
import { namesFor } from "@/lib/hiring/user-names";
import { lapseExpiredSentOffers } from "@/lib/hiring/offer-lapse";


// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type StageRow = {
  id: string; candidateId: string; stageKey: string; label: string;
  stageType: string; ownerUserId: string | null; status: string;
  scheduledAt: Date | null; remarks: string; rating: number | null;
  strengths: string; concerns: string; recommendation: string | null;
  eventId: string | null;
  sortOrder: number; startedAt: Date | null; completedAt: Date | null;
};

function serializeStage(
  s: StageRow,
  names: Map<string, string>,
): CandidateStageT {
  return {
    id: s.id,
    stageKey: s.stageKey,
    label: s.label,
    stageType: s.stageType,
    ownerUserId: s.ownerUserId,
    ownerName: s.ownerUserId ? names.get(s.ownerUserId) ?? null : null,
    status: s.status,
    scheduledAt: s.scheduledAt ? s.scheduledAt.toISOString() : null,
    remarks: s.remarks,
    rating: s.rating,
    strengths: s.strengths,
    concerns: s.concerns,
    recommendation: s.recommendation,
    eventId: s.eventId,
    sortOrder: s.sortOrder,
    startedAt: s.startedAt ? s.startedAt.toISOString() : null,
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
  };
}

type CandidateRow = {
  id: string; fullName: string; email: string; phone: string; position: string;
  department: string; source: string; resumeUrl: string; notes: string;
  status: string; rejectReason: string; decidedAt: Date | null;
  createdById: string; userId: string | null; joinedAt: Date | null;
  createdAt: Date; stages: StageRow[];
};

function serializeCandidate(
  c: CandidateRow,
  names: Map<string, string>,
): CandidateT {
  return {
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    position: c.position,
    department: c.department,
    source: c.source,
    resumeUrl: c.resumeUrl,
    notes: c.notes,
    status: c.status,
    rejectReason: c.rejectReason,
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
    createdById: c.createdById,
    userId: c.userId,
    joinedAt: c.joinedAt ? c.joinedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    stages: c.stages
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => serializeStage(s, names)),
  };
}



// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getHiringBoard(): Promise<
  ActionResult<{ stages: HiringStageConfigT[]; candidates: CandidateT[] }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    void auth;
    const [templates, candidates] = await Promise.all([
      db.hiringStageConfig.findMany({ orderBy: [{ sortOrder: "asc" }, { key: "asc" }] }),
      db.candidate.findMany({
        include: { stages: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const names = await namesFor(
      candidates.flatMap((c) => c.stages.map((s) => s.ownerUserId ?? "")),
    );
    return {
      stages: templates.map((t) => ({
        id: t.id, key: t.key, label: t.label, stageType: t.stageType,
        ownerRole: t.ownerRole, description: t.description,
        sortOrder: t.sortOrder, isActive: t.isActive,
      })),
      candidates: candidates.map((c) => serializeCandidate(c, names)),
    };
  });
}

export async function getStageTemplates(): Promise<ActionResult<HiringStageConfigT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:view");
    const templates = await db.hiringStageConfig.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return templates.map((t) => ({
      id: t.id, key: t.key, label: t.label, stageType: t.stageType,
      ownerRole: t.ownerRole, description: t.description,
      sortOrder: t.sortOrder, isActive: t.isActive,
    }));
  });
}

// ---------------------------------------------------------------------------
// Candidate CRUD (hiring:manage)
// ---------------------------------------------------------------------------

export async function createCandidate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(createCandidateSchema, input);

    // Instantiate the pipeline from the ACTIVE template rows — the snapshot
    // moment. Label/type are COPIES: later template edits must not rewrite
    // this candidate's timeline.
    const templates = await db.hiringStageConfig.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });

    const created = await db.candidate.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        position: data.position,
        department: data.department,
        source: data.source,
        resumeUrl: data.resumeUrl,
        notes: data.notes,
        createdById: auth.userId,
        stages: {
          create: templates.map((t, i) => ({
            stageKey: t.key,
            label: t.label,
            stageType: t.stageType,
            status: i === 0 ? "IN_PROGRESS" : "PENDING",
            sortOrder: t.sortOrder,
            startedAt: i === 0 ? new Date() : null,
          })),
        },
      },
    });

    await logAudit({
      actor: auth,
      action: "hiring.candidate_created",
      entityType: "CANDIDATE",
      entityId: created.id,
      entityLabel: created.fullName,
      detail: `${auth.name} added candidate "${created.fullName}" (${created.position || "position n/a"}) with ${templates.length} pipeline stages.`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

export async function updateCandidate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(updateCandidateSchema, input);
    const existing = await db.candidate.findUnique({ where: { id: data.id } });
    if (!existing) {
      throw new AuthorizationError("Candidate not found.");
    }
    try {
      await db.candidate.update({
        where: { id: data.id },
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          position: data.position,
          department: data.department,
          source: data.source,
          resumeUrl: data.resumeUrl,
          notes: data.notes,
        },
      });
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError("Another candidate already uses this email.");
      }
      throw e;
    }
    await logAudit({
      actor: auth,
      action: "hiring.candidate_updated",
      entityType: "CANDIDATE",
      entityId: data.id,
      entityLabel: data.fullName,
      detail: `${auth.name} updated candidate "${data.fullName}".`,
    });
    revalidatePath("/");
    return { id: data.id };
  });
}

export async function deleteCandidate(input: { id: string }): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const existing = await db.candidate.findUnique({
      where: { id: input?.id ?? "" },
      include: { stages: { select: { status: true } } },
    });
    if (!existing) {
      throw new AuthorizationError("Candidate not found.");
    }
    // Guard: never delete a candidate that became an employee — the employee
    // record (userId) is the system of record once set.
    if (existing.userId) {
      throw new AuthorizationError("This candidate already joined — delete the employee record instead.");
    }
    await db.candidate.delete({ where: { id: existing.id } });
    await logAudit({
      actor: auth,
      action: "hiring.candidate_deleted",
      entityType: "CANDIDATE",
      entityId: existing.id,
      entityLabel: existing.fullName,
      detail: `${auth.name} deleted candidate "${existing.fullName}" and its ${existing.stages.length} stage records.`,
    });
    revalidatePath("/");
    return { id: existing.id };
  });
}

// ---------------------------------------------------------------------------
// Stage transitions (hiring:manage)
// ---------------------------------------------------------------------------

/**
 * Advance the candidate's current stage: the first stage that is IN_PROGRESS
 * (or, if none, the first PENDING one) is marked PASSED, and the next PENDING
 * stage is started (IN_PROGRESS + startedAt). Passing the last stage leaves
 * the candidate ACTIVE — hiring/rejecting is a separate explicit decision.
 */
export async function advanceStage(input: { candidateId: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const candidate = await db.candidate.findUnique({
      where: { id: input?.candidateId ?? "" },
      include: { stages: true },
    });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${candidate.status} — the pipeline is closed.`);
    }
    const ordered = candidate.stages.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const current =
      ordered.find((s) => s.status === "IN_PROGRESS") ??
      ordered.find((s) => s.status === "PENDING");
    if (!current) {
      throw new AuthorizationError("No open stage to advance — every stage is already closed.");
    }
    const next = ordered.find((s) => s.status === "PENDING" && s.sortOrder > current.sortOrder);

    const now = new Date();
    // F-R12 (S17) — closing one stage and opening the next is ONE atomic
    // step: a crash between the two writes could otherwise leave a pipeline
    // with no open stage at all.
    await db.$transaction(async (tx) => {
      await tx.candidateStage.update({
        where: { id: current.id },
        data: { status: "PASSED", completedAt: now },
      });
      if (next) {
        await tx.candidateStage.update({
          where: { id: next.id },
          data: { status: "IN_PROGRESS", startedAt: now },
        });
      }
    });
    await logAudit({
      actor: auth,
      action: "hiring.stage_advanced",
      entityType: "CANDIDATE",
      entityId: candidate.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} passed "${current.label}"${next ? ` — next: "${next.label}"` : " — pipeline complete"}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Set an explicit stage status (PASSED/FAILED/SKIPPED) with remarks — the
 * per-candidate override path. FAILED/SKIPPED skip the auto-start of the next
 * stage; the next advance picks up the following PENDING stage. */
export async function setStageStatus(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(setStageStatusSchema, input);
    const stage = await db.candidateStage.findUnique({
      where: { id: data.stageId },
      include: { candidate: true },
    });
    if (!stage) throw new AuthorizationError("Stage not found.");
    if (stage.candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${stage.candidate.status} — the pipeline is closed.`);
    }
    await db.candidateStage.update({
      where: { id: stage.id },
      data: {
        status: data.status,
        completedAt: new Date(),
        remarks: data.remarks || stage.remarks,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.stage_status_changed",
      entityType: "CANDIDATE",
      entityId: stage.candidateId,
      entityLabel: stage.candidate.fullName,
      detail: `${auth.name} set "${stage.label}" to ${data.status}${data.remarks ? ` — "${data.remarks}"` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Per-candidate override: add an extra custom stage (e.g. a second loop the
 * template doesn't define). Key is namespaced `custom:<id>` so it can't clash
 * with template keys. */
export async function addCandidateStage(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(addCandidateStageSchema, input);
    const candidate = await db.candidate.findUnique({
      where: { id: data.candidateId },
      include: { stages: true },
    });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${candidate.status} — the pipeline is closed.`);
    }
    const ordered = candidate.stages.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    let sortOrder: number;
    if (data.beforeStageId) {
      const anchor = ordered.find((s) => s.id === data.beforeStageId);
      if (!anchor) throw new AuthorizationError("Insertion point stage not found.");
      sortOrder = anchor.sortOrder;
    } else {
      sortOrder = ordered.length > 0 ? ordered[ordered.length - 1].sortOrder + 1 : 0;
    }
    // F-R12 (S17) — the sortOrder shift AND the new row land in ONE
    // transaction (previously a parallel Promise.all outside any tx: a
    // mid-flight failure could leave duplicate sortOrders with no inserted
    // stage). Sequential inside the tx — the order is the guarantee.
    const created = await db.$transaction(async (tx) => {
      if (data.beforeStageId) {
        for (const st of ordered.filter((x) => x.sortOrder >= sortOrder)) {
          await tx.candidateStage.update({
            where: { id: st.id },
            data: { sortOrder: st.sortOrder + 1 },
          });
        }
      }
      return tx.candidateStage.create({
        data: {
          candidateId: candidate.id,
          stageKey: `custom:${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
          label: data.label,
          stageType: data.stageType,
          status: "PENDING",
          sortOrder,
        },
      });
    });
    await logAudit({
      actor: auth,
      action: "hiring.stage_added",
      entityType: "CANDIDATE",
      entityId: candidate.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} added stage "${data.label}" to ${candidate.fullName}'s pipeline.`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

// ---------------------------------------------------------------------------
// Decisions (hiring:manage) — SELECT / REJECT / WITHDRAW / REACTIVATE.
// R3: SELECT moves the candidate to the SELECTED pool (offer prep), and
// REJECT can queue a rejection email (MailOutbox + provider send). The
// internal `reason` is audit-only; the email carries HR-approved remarks.
// P0-6 (D-05/D-18, persona-audit): the action returns the real mail status
// so the UI can tell the truth about delivery, and a duplicate-email guard
// (one outbox send per candidate + kind + UTC day) blocks a same-day repeat
// BEFORE any state mutation.
// ---------------------------------------------------------------------------

export async function decideCandidate(input: unknown): Promise<ActionResult<{ ok: true; mailStatus: string | null }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(decideCandidateSchema, input);
    const candidate = await db.candidate.findUnique({
      where: { id: data.candidateId },
    });
    if (!candidate) throw new AuthorizationError("Candidate not found.");

    let mailStatus: string | null = null;

    // F-R12 (S17) — every decision path below writes exactly ONE row (the
    // candidate status flip): single-row writes are atomic by themselves,
    // and the optional rejection email is DELIBERATELY outside any
    // transaction (a provider outage must not roll back the decision —
    // see queueCandidateEmail's contract).
    if (data.decision === "REACTIVATE") {
      if (
        candidate.status !== "REJECTED" &&
        candidate.status !== "WITHDRAWN" &&
        candidate.status !== "SELECTED"
      ) {
        throw new AuthorizationError("Only rejected, withdrawn, or selected candidates can be reactivated.");
      }
      await db.candidate.update({
        where: { id: candidate.id },
        data: { status: "ACTIVE", rejectReason: "", decidedAt: null, decidedById: null },
      });
      await logAudit({
        actor: auth,
        action: "hiring.decided",
        entityType: "CANDIDATE",
        entityId: candidate.id,
        entityLabel: candidate.fullName,
        detail: `${auth.name} reactivated candidate "${candidate.fullName}".`,
      });
    } else if (data.decision === "SELECT") {
      // R3 — the hire decision: ACTIVE → SELECTED. The candidate leaves the
      // active pipeline (SELECTED pool) and waits for offer preparation
      // (offer builder ships in R5; the UI shows the prep pointer).
      if (candidate.status !== "ACTIVE") {
        throw new AuthorizationError(`Candidate is already ${candidate.status}.`);
      }
      await db.candidate.update({
        where: { id: candidate.id },
        data: { status: "SELECTED", decidedAt: new Date(), decidedById: auth.userId },
      });
      await logAudit({
        actor: auth,
        action: "hiring.decided",
        entityType: "CANDIDATE",
        entityId: candidate.id,
        entityLabel: candidate.fullName,
        detail: `${auth.name} selected "${candidate.fullName}" — offer preparation pending.`,
      });
    } else {
      if (candidate.status !== "ACTIVE") {
        throw new AuthorizationError(`Candidate is already ${candidate.status}.`);
      }
      if (data.decision === "REJECT" && data.reason.trim().length === 0) {
        throw new AuthorizationError("A rejection reason is required.");
      }

      // D-18 (P0-6) — duplicate-email guard: run BEFORE the candidate update
      // so a blocked duplicate never half-applies the decision (the update is
      // not inside a transaction with the email send). Blocking semantics per
      // the fix decision: HR unchecks "Email the candidate" and retries.
      if (data.decision === "REJECT" && data.sendEmail) {
        await assertNoDuplicateOutboxEmail(candidate.id, "REJECTION", candidate.fullName);
      }

      await db.candidate.update({
        where: { id: candidate.id },
        data: {
          status: data.decision === "REJECT" ? "REJECTED" : "WITHDRAWN",
          rejectReason: data.decision === "REJECT" ? data.reason : "",
          decidedAt: new Date(),
          decidedById: auth.userId,
        },
      });
      await logAudit({
        actor: auth,
        action: "hiring.decided",
        entityType: "CANDIDATE",
        entityId: candidate.id,
        entityLabel: candidate.fullName,
        detail: `${auth.name} marked "${candidate.fullName}" as ${data.decision === "REJECT" ? "REJECTED" : "WITHDRAWN"}${data.reason ? ` — "${data.reason}"` : ""}.`,
      });

      // R3 — opt-in rejection email: queue the MailOutbox row, attempt the
      // send, and record the outcome (SENT / SKIPPED / FAILED). A provider
      // outage must not fail the decision itself — the failure lands in the
      // outbox where HR can see it. P0-6: the status travels back to the UI
      // so the toast can mirror it honestly.
      if (data.decision === "REJECT" && data.sendEmail) {
        const sent = await queueCandidateEmail({
          kind: "REJECTION",
          candidate: { id: candidate.id, fullName: candidate.fullName, email: candidate.email, position: candidate.position },
          remarks: data.emailRemarks,
          auth,
        });
        mailStatus = sent.status;
      }
    }
    revalidatePath("/");
    return { ok: true, mailStatus };
  });
}

// ---------------------------------------------------------------------------
// R3 — candidate email outbox (MailOutbox + provider send)
// ---------------------------------------------------------------------------

type EmailActor = { userId: string; name: string; role: string };

/** D-18 (P0-6) — duplicate-email guard: at most one outbox send per
 * (candidate, kind, UTC day). Application-level check-then-act — the same
 * pattern as the interview clash check in scheduleInterview; the natural
 * writers are already single-shot (offers are DRAFT→SENT one-way, markJoined
 * is idempotent), so the exposed surface is REJECTION (reactivate → re-reject
 * same day). UTC day boundary keeps it deterministic and testable; the
 * check-then-create race window is bounded by the sequential HR UI. */
async function assertNoDuplicateOutboxEmail(
  candidateId: string,
  kind: string,
  candidateName: string,
): Promise<void> {
  const now = new Date();
  const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dup = await db.mailOutbox.findFirst({
    where: { candidateId, kind, createdAt: { gte: startOfUtcDay } },
    select: { id: true },
  });
  if (dup) {
    throw new AuthorizationError(
      `A ${kind.toLowerCase()} email was already sent to ${candidateName} today — at most one per candidate per day. ` +
        `Uncheck "Email the candidate" to record the decision without another send, or retry tomorrow.`,
    );
  }
}

/** Compose → persist QUEUED → attempt delivery → resolve the row to
 * SENT / SKIPPED / FAILED. Never throws for provider failures (best-effort
 * like the password-reset mail path): the outbox row is the error surface
 * for HR. Throws only on the D-18 duplicate guard (belt-and-braces — the
 * decideCandidate-level check already runs before any state mutation). */
async function queueCandidateEmail(input: {
  kind: "REJECTION";
  candidate: { id: string; fullName: string; email: string; position: string };
  remarks: string;
  auth: EmailActor;
}): Promise<{ outboxId: string; status: string }> {
  // D-18 — keep the invariant true for any future caller of this helper too.
  await assertNoDuplicateOutboxEmail(input.candidate.id, input.kind, input.candidate.fullName);
  const config = await getWorkspaceConfig();
  const email = composeRejectionEmail({
    candidateName: input.candidate.fullName,
    position: input.candidate.position,
    workspaceName: config.workspace.name,
    remarks: input.remarks,
  });

  const row = await db.mailOutbox.create({
    data: {
      kind: input.kind,
      candidateId: input.candidate.id,
      toAddress: input.candidate.email,
      subject: email.subject,
      body: email.text,
      status: "QUEUED",
      sentById: input.auth.userId,
    },
  });

  let status = "SKIPPED";
  let providerMessageId = "";
  let error = "";
  try {
    const result = await createMailer().sendMail({
      to: input.candidate.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (result.delivered) {
      status = "SENT";
      providerMessageId = result.messageId ?? "";
    }
  } catch (err) {
    status = "FAILED";
    error = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  }

  await db.mailOutbox.update({
    where: { id: row.id },
    data: {
      status,
      providerMessageId,
      error,
      sentAt: new Date(),
    },
  });

  await logAudit({
    actor: input.auth,
    action: "hiring.email_queued",
    entityType: "MAIL_OUTBOX",
    entityId: row.id,
    entityLabel: email.subject,
    detail:
      `${input.auth.name} sent a ${input.kind.toLowerCase()} email to ${input.candidate.email} — ` +
      (status === "SENT"
        ? `delivered${providerMessageId ? ` (provider id ${providerMessageId})` : ""}.`
        : status === "SKIPPED"
          ? "SKIPPED: no mail provider configured (set RESEND_API_KEY to deliver)."
          : `FAILED: ${error}`),
  });

  return { outboxId: row.id, status };
}

/** Outbox viewer (hiring:manage) — the audited history of every
 * candidate-facing email, newest first. */
export async function getMailOutbox(): Promise<ActionResult<MailOutboxT[]>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    void auth;
    const rows = await db.mailOutbox.findMany({
      include: { candidate: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const names = await namesFor(rows.map((r) => r.sentById));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      candidateId: r.candidateId,
      candidateName: r.candidate?.fullName ?? null,
      toAddress: r.toAddress,
      subject: r.subject,
      body: r.body,
      status: r.status,
      sentBy: names.get(r.sentById) ?? null,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      providerMessageId: r.providerMessageId,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

// ---------------------------------------------------------------------------
// Stage-template editor (hiring:config)
// ---------------------------------------------------------------------------

export async function saveStageTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(saveStageTemplateSchema, input);
    try {
      const saved = data.id
        ? await db.hiringStageConfig.update({ where: { id: data.id }, data })
        : await db.hiringStageConfig.create({ data });
      await logAudit({
        actor: auth,
        action: "hiring.stage_template_saved",
        entityType: "CONFIG",
        entityId: saved.id,
        entityLabel: saved.label,
        detail: `${auth.name} ${data.id ? "updated" : "created"} hiring stage "${saved.label}" (${saved.stageType}, owner ${saved.ownerRole}).`,
      });
      revalidatePath("/");
      return { id: saved.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`Stage key "${data.key}" is already used by another stage.`);
      }
      throw e;
    }
  });
}

export async function deleteStageTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(deleteStageTemplateSchema, input);
    const existing = await db.hiringStageConfig.findUnique({ where: { id: data.id } });
    if (!existing) throw new AuthorizationError("Stage template not found.");
    // Existing candidates keep their snapshot rows — deletion only removes
    // the template row, so no candidate history is lost (configurability
    // contract, docs/RECRUITMENT_MODULE_PLAN.md §1.4).
    await db.hiringStageConfig.delete({ where: { id: existing.id } });
    await logAudit({
      actor: auth,
      action: "hiring.stage_template_deleted",
      entityType: "CONFIG",
      entityId: existing.id,
      entityLabel: existing.label,
      detail: `${auth.name} removed hiring stage "${existing.label}" from the template (existing candidates keep their snapshots).`,
    });
    revalidatePath("/");
    return { id: existing.id };
  });
}

// ---------------------------------------------------------------------------
// Permission probes for the client (avoids shipping role checks that would
// bypass the DB-driven ceiling, L-P0-7).
// ---------------------------------------------------------------------------

export async function getHiringPermissions(): Promise<
  ActionResult<{ canManage: boolean; canConfig: boolean; canApprove: boolean; mailConfigured: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    // F-R13: DB-aware probes — the client's capability buttons must reflect
    // DB grants (hiring:manage/hiring:config/hiring:approve), not the static
    // floor alone.
    const canManage = await checkPermission(auth.role, "hiring:manage");
    const canConfig = await checkPermission(auth.role, "hiring:config");
    // F2.10 — the manager-approver probe drives the Offer approvals panel.
    const canApprove = await checkPermission(auth.role, "hiring:approve");
    // P0-6 (D-05/D-18) — first-run guidance: the hiring view warns when no
    // transactional mail provider is wired. Same env source of truth as the
    // mailer factory (lib/email/mailer.ts createMailer), so the banner can never
    // disagree with what actually happens on a send.
    const mailConfigured = Boolean(process.env.RESEND_API_KEY);
    return { canManage, canConfig, canApprove, mailConfigured };
  });
}

// ---------------------------------------------------------------------------
// R8 — funnel analytics (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R8).
// hiring:view (interviewers included — counts and durations are not
// salary-sensitive): candidate pool totals, per-stage load + velocity
// (average days in stage over started instances), and the offer funnel
// (sent → signed/declined with the accept rate over DECIDED offers).
// ---------------------------------------------------------------------------

export async function getHiringFunnel(): Promise<
  ActionResult<{
    totals: { total: number; active: number; selected: number; hired: number; rejected: number; withdrawn: number };
    stages: Array<{ stageKey: string; label: string; inStage: number; passed: number; avgDays: number | null }>;
    offers: { total: number; awaiting: number; signed: number; declined: number; expired: number; acceptRate: number | null };
  }>
> {
  return toResult(async () => {
    await requirePermission("hiring:view");
    // F-R5/F2.10 — converge the DB on the honest state first (SENT links
    // past their expiry become EXPIRED), then count. Belt and suspenders:
    // awaiting ALSO filters through the pure predicate so the number is
    // honest even for a row a concurrent read has not lapsed yet.
    await lapseExpiredSentOffers();
    const [candidates, stageRows, offerRows] = await Promise.all([
      db.candidate.findMany({ select: { status: true } }),
      db.candidateStage.findMany({
        select: { stageKey: true, label: true, status: true, startedAt: true, completedAt: true },
      }),
      db.offerRecord.findMany({ select: { status: true, tokenExpiresAt: true } }),
    ]);

    const count = (s: string) => candidates.filter((c) => c.status === s).length;

    // Stage metrics grouped by the snapshotted (stageKey, label) — template
    // renames create distinct groups, which is exactly right for history.
    const now = Date.now();
    const groups = new Map<string, { label: string; inStage: number; passed: number; days: number[] }>();
    for (const s of stageRows) {
      const key = s.stageKey;
      let g = groups.get(key);
      if (!g) {
        g = { label: s.label, inStage: 0, passed: 0, days: [] };
        groups.set(key, g);
      }
      if (s.status === "IN_PROGRESS") g.inStage += 1;
      if (s.status === "PASSED") g.passed += 1;
      // Velocity: started → completed (PASSED) or started → now (IN_PROGRESS).
      const from = s.startedAt?.getTime();
      const to = s.status === "PASSED" ? s.completedAt?.getTime() : s.status === "IN_PROGRESS" ? now : undefined;
      if (from && to && to >= from) {
        g.days.push((to - from) / 86_400_000);
      }
    }
    const stages = [...groups.entries()]
      .map(([stageKey, g]) => ({
        stageKey,
        label: g.label,
        inStage: g.inStage,
        passed: g.passed,
        avgDays: g.days.length > 0
          ? Math.round((g.days.reduce((a, b) => a + b, 0) / g.days.length) * 10) / 10
          : null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const signed = offerRows.filter((o) => o.status === "SIGNED").length;
    const declined = offerRows.filter((o) => o.status === "DECLINED").length;
    // F-R5 — a live link is SENT and not yet past its expiry; a stale one
    // counts as expired (lapsed or lapsing — both are dead links).
    const awaiting = offerRows.filter(
      (o) => o.status === "SENT" && !isOfferLinkExpired(o.tokenExpiresAt),
    ).length;
    const expired = offerRows.filter(
      (o) => o.status === "EXPIRED" || (o.status === "SENT" && isOfferLinkExpired(o.tokenExpiresAt)),
    ).length;

    return {
      totals: {
        total: candidates.length,
        active: count("ACTIVE"),
        selected: count("SELECTED"),
        hired: count("HIRED"),
        rejected: count("REJECTED"),
        withdrawn: count("WITHDRAWN"),
      },
      stages,
      offers: {
        total: offerRows.length,
        awaiting,
        signed,
        declined,
        expired,
        // Accept rate over DECIDED offers only (pending offers are neither
        // accepted nor lost — null until the first decision lands).
        acceptRate: signed + declined > 0 ? Math.round((signed / (signed + declined)) * 100) : null,
      },
    };
  });
}
