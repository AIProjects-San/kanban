"use server";

// ---------------------------------------------------------------------------
// Recruitment module R1 — hiring server actions
// (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R1).
//
// RBAC:
//   hiring:view   — read the board + templates (ADMIN, HR, MANAGER)
//   hiring:manage — candidate CRUD, advance stages, decide (ADMIN, HR)
//   hiring:config — stage-template editor (ADMIN, HR)
//
// Configurability contract: candidates snapshot the template at creation
// (label/stageType copied), so template edits never rewrite history. The
// per-candidate override paths are setStageStatus(SKIPPED) and
// addCandidateStage (extra custom stage for one person).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import type {
  CandidateT,
  CandidateStageT,
  HiringStageConfigT,
  MailOutboxT,
  DocumentTypeConfigT,
  CandidateDocumentT,
  BackgroundCheckT,
  OfferTemplateT,
  OfferRecordT,
} from "@/lib/types";
import {
  createCandidateSchema,
  updateCandidateSchema,
  setStageStatusSchema,
  addCandidateStageSchema,
  decideCandidateSchema,
  saveStageTemplateSchema,
  deleteStageTemplateSchema,
  scheduleInterviewSchema,
  scorecardSchema,
  saveDocumentTypeSchema,
  deleteDocumentTypeSchema,
  requestDocumentSchema,
  receiveDocumentSchema,
  verifyDocumentSchema,
  rejectDocumentSchema,
  initiateBackgroundCheckSchema,
  updateBackgroundCheckSchema,
  saveOfferTemplateSchema,
  deleteOfferTemplateSchema,
  createOfferRecordSchema,
  updateOfferRecordSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
// R3 — decisions & candidate email outbox.
import { composeRejectionEmail } from "@/lib/hiring-email";
import { createMailer } from "@/lib/mailer";
import { getWorkspaceConfig } from "@/lib/config-loader";
// R5 — offer builder math + letter rendering.
import { computeOffer, parseComponents, parseBenefits, renderOfferLetter, formatMoney } from "@/lib/offer-math";
// R6 — account creation for joined hires + shared HTML escaping.
import { hashPassword } from "@/lib/password";
import { escapeHtml } from "@/lib/utils";

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

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
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
    await db.candidateStage.update({
      where: { id: current.id },
      data: { status: "PASSED", completedAt: now },
    });
    if (next) {
      await db.candidateStage.update({
        where: { id: next.id },
        data: { status: "IN_PROGRESS", startedAt: now },
      });
    }
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
      // Shift every stage at or after the insertion point up by one so the
      // new stage slots in exactly there (order stays dense within reason).
      await Promise.all(
        ordered
          .filter((s) => s.sortOrder >= sortOrder)
          .map((s) =>
            db.candidateStage.update({
              where: { id: s.id },
              data: { sortOrder: s.sortOrder + 1 },
            }),
          ),
      );
    } else {
      sortOrder = ordered.length > 0 ? ordered[ordered.length - 1].sortOrder + 1 : 0;
    }
    const created = await db.candidateStage.create({
      data: {
        candidateId: candidate.id,
        stageKey: `custom:${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        label: data.label,
        stageType: data.stageType,
        status: "PENDING",
        sortOrder,
      },
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
// ---------------------------------------------------------------------------

export async function decideCandidate(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(decideCandidateSchema, input);
    const candidate = await db.candidate.findUnique({
      where: { id: data.candidateId },
    });
    if (!candidate) throw new AuthorizationError("Candidate not found.");

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
      // outbox where HR can see it.
      if (data.decision === "REJECT" && data.sendEmail) {
        await queueCandidateEmail({
          kind: "REJECTION",
          candidate: { id: candidate.id, fullName: candidate.fullName, email: candidate.email, position: candidate.position },
          remarks: data.emailRemarks,
          auth,
        });
      }
    }
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// R3 — candidate email outbox (MailOutbox + provider send)
// ---------------------------------------------------------------------------

type EmailActor = { userId: string; name: string; role: string };

/** Compose → persist QUEUED → attempt delivery → resolve the row to
 * SENT / SKIPPED / FAILED. Never throws (best-effort like the password-reset
 * mail path): the outbox row is the error surface for HR. */
async function queueCandidateEmail(input: {
  kind: "REJECTION";
  candidate: { id: string; fullName: string; email: string; position: string };
  remarks: string;
  auth: EmailActor;
}): Promise<{ outboxId: string; status: string }> {
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
// R2 — Interview scheduling + scorecards (hiring:manage / stage owner).
//
// Scheduling an INTERVIEW stage creates a CalendarEvent (so it lands on the
// shared Calendar) + a personal Reminder for the interviewer, records
// scheduledAt/ownerUserId/eventId, and refuses a conflicting booking (the
// same interviewer already has another interview within the same hour).
// The scorecard is the structured research-D form: 1-5 rating,
// strengths/concerns, and a STRONG_HIRE | HIRE | NO_HIRE recommendation.
// ---------------------------------------------------------------------------

export async function scheduleInterview(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(scheduleInterviewSchema, input);
    const when = new Date(data.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new AuthorizationError("The scheduled date/time is invalid.");
    }
    const stage = await db.candidateStage.findUnique({
      where: { id: data.stageId },
      include: { candidate: true },
    });
    if (!stage) throw new AuthorizationError("Stage not found.");
    if (stage.candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${stage.candidate.status} — the pipeline is closed.`);
    }
    if (stage.stageType !== "INTERVIEW") {
      throw new AuthorizationError("Interviews can only be scheduled on INTERVIEW stages.");
    }
    const interviewerId = data.interviewerId ?? stage.ownerUserId;
    if (!interviewerId) {
      throw new AuthorizationError("Pick an interviewer before scheduling.");
    }

    // Conflict check: the same interviewer must not have two interviews in
    // the same hour window (±59 min around `when`). Only counts non-skipped
    // stages — a skipped loop never happens.
    const nearby = await db.candidateStage.findMany({
      where: {
        ownerUserId: interviewerId,
        id: { not: stage.id },
        status: { not: "SKIPPED" },
        scheduledAt: { not: null, gte: new Date(when.getTime() - 59 * 60_000), lte: new Date(when.getTime() + 59 * 60_000) },
      },
      select: { label: true, candidate: { select: { fullName: true } } },
    });
    if (nearby.length > 0) {
      const clash = nearby[0];
      throw new AuthorizationError(
        `Scheduling conflict: ${clash.candidate.fullName} has "${clash.label}" within the same hour for this interviewer.`,
      );
    }

    const event = await db.calendarEvent.create({
      data: {
        title: `Interview: ${stage.candidate.fullName} — ${stage.label}`,
        description: `${stage.candidate.position || "Position n/a"} · ${stage.candidate.email}`,
        date: when,
        time: `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`,
        durationMin: 60,
        type: "MEETING",
        location: stage.candidate.department || "",
      },
    });
    await db.reminder.create({
      data: {
        title: `Interview with ${stage.candidate.fullName} (${stage.label})`,
        dueDate: when,
        ownerId: interviewerId,
      },
    });
    await db.candidateStage.update({
      where: { id: stage.id },
      data: { scheduledAt: when, ownerUserId: interviewerId, eventId: event.id },
    });
    await logAudit({
      actor: auth,
      action: stage.scheduledAt ? "hiring.interview_rescheduled" : "hiring.interview_scheduled",
      entityType: "CANDIDATE",
      entityId: stage.candidateId,
      entityLabel: stage.candidate.fullName,
      detail: `${auth.name} scheduled "${stage.label}" with ${stage.candidate.fullName} for ${when.toISOString()} (calendar event + interviewer reminder created).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

export async function saveScorecard(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    const data = parseOrThrow(scorecardSchema, input);
    const stage = await db.candidateStage.findUnique({
      where: { id: data.stageId },
      include: { candidate: { select: { id: true, fullName: true, status: true } } },
    });
    if (!stage) throw new AuthorizationError("Stage not found.");
    // The assigned interviewer may fill their OWN scorecard; everyone else
    // needs hiring:manage (HR-driven — HR can record on behalf).
    const isOwner = stage.ownerUserId === auth.userId;
    if (!isOwner && !hasPermission(auth.role, "hiring:manage")) {
      throw new AuthorizationError("Only the assigned interviewer or an HR/admin can fill this scorecard.");
    }
    if (stage.candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${stage.candidate.status} — the pipeline is closed.`);
    }
    await db.candidateStage.update({
      where: { id: stage.id },
      data: {
        rating: data.rating ?? null,
        strengths: data.strengths,
        concerns: data.concerns,
        recommendation: data.recommendation ?? null,
        remarks: data.remarks || stage.remarks,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.scorecard_saved",
      entityType: "CANDIDATE",
      entityId: stage.candidateId,
      entityLabel: stage.candidate.fullName,
      detail: `${auth.name} saved the "${stage.label}" scorecard for ${stage.candidate.fullName}` +
        `${data.rating ? ` (rating ${data.rating}/5, ${data.recommendation ?? "no recommendation"})` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Interviewer self-service: my assigned, still-open interview stages (any
 * signed-in user — the WHERE clause scopes to the caller's own rows). */
export async function getMyInterviews(): Promise<
  ActionResult<
    Array<{
      stageId: string;
      stageLabel: string;
      candidateId: string;
      candidateName: string;
      position: string;
      status: string;
      scheduledAt: string | null;
      rating: number | null;
      recommendation: string | null;
    }>
  >
> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    const rows = await db.candidateStage.findMany({
      where: {
        ownerUserId: auth.userId,
        stageType: "INTERVIEW",
        status: { in: ["PENDING", "IN_PROGRESS"] },
        candidate: { status: "ACTIVE" },
      },
      include: { candidate: { select: { id: true, fullName: true, position: true, status: true } } },
      orderBy: { scheduledAt: "asc" },
    });
    return rows.map((r) => ({
      stageId: r.id,
      stageLabel: r.label,
      candidateId: r.candidateId,
      candidateName: r.candidate.fullName,
      position: r.candidate.position,
      status: r.status,
      scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
      rating: r.rating,
      recommendation: r.recommendation,
    }));
  });
}

// ---------------------------------------------------------------------------
// Permission probes for the client (avoids shipping role checks that would
// bypass the DB-driven ceiling, L-P0-7).
// ---------------------------------------------------------------------------

export async function getHiringPermissions(): Promise<
  ActionResult<{ canManage: boolean; canConfig: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    const canManage = hasPermission(auth.role, "hiring:manage");
    const canConfig = hasPermission(auth.role, "hiring:config");
    return { canManage, canConfig };
  });
}

// ---------------------------------------------------------------------------
// R4 — joining formalities: document checklist + background checks
// (docs/RECRUITMENT_MODULE_PLAN.md §5 R4). All manage ops are hiring:manage;
// the checklist template editor is hiring:config. Documents reference
// DocumentTypeConfig by KEY; the label is snapshotted at request time so
// template renames never orphan candidate history.
// ---------------------------------------------------------------------------

/** The workspace document-checklist template (hiring:view). */
export async function getDocumentTypes(): Promise<ActionResult<DocumentTypeConfigT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:view");
    const rows = await db.documentTypeConfig.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map(serializeDocType);
  });
}

function serializeDocType(t: {
  id: string; key: string; label: string; description: string;
  isMandatory: boolean; sortOrder: number; isActive: boolean;
}): DocumentTypeConfigT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    isMandatory: t.isMandatory, sortOrder: t.sortOrder, isActive: t.isActive,
  };
}

export async function saveDocumentType(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(saveDocumentTypeSchema, input);
    const row = data.id
      ? await db.documentTypeConfig.update({ where: { id: data.id }, data })
      : await db.documentTypeConfig.create({ data });
    await logAudit({
      actor: auth,
      action: "hiring.doc_type_saved",
      entityType: "DOCUMENT_TYPE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} ${data.id ? "updated" : "added"} document type "${row.label}"${data.isMandatory ? " (mandatory)" : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function deleteDocumentType(input: { id: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(deleteDocumentTypeSchema, input);
    const row = await db.documentTypeConfig.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hiring.doc_type_deleted",
      entityType: "DOCUMENT_TYPE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} removed document type "${row.label}" from the template (existing candidates keep their history).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Everything the joining-formalities panel needs for one candidate
 * (hiring:manage — documents are HR-sensitive). */
export async function getJoiningFormalities(
  candidateId: string,
): Promise<ActionResult<{
  docTypes: DocumentTypeConfigT[];
  documents: CandidateDocumentT[];
  bgChecks: BackgroundCheckT[];
}>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    const [docTypes, documents, bgChecks] = await Promise.all([
      db.documentTypeConfig.findMany({ orderBy: [{ sortOrder: "asc" }, { key: "asc" }] }),
      db.candidateDocument.findMany({
        where: { candidateId },
        orderBy: { requestedAt: "asc" },
      }),
      db.backgroundCheck.findMany({
        where: { candidateId },
        orderBy: { initiatedAt: "desc" },
      }),
    ]);
    const names = await namesFor([
      ...documents.map((d) => d.verifiedById),
      ...bgChecks.map((b) => b.initiatedById),
    ]);
    return {
      docTypes: docTypes.map(serializeDocType),
      documents: documents.map((d) => ({
        id: d.id, candidateId: d.candidateId, docTypeKey: d.docTypeKey,
        label: d.label, status: d.status, fileRef: d.fileRef, remarks: d.remarks,
        requestedAt: d.requestedAt.toISOString(),
        receivedAt: d.receivedAt ? d.receivedAt.toISOString() : null,
        verifiedBy: names.get(d.verifiedById) ?? null,
        verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
      })),
      bgChecks: bgChecks.map((b) => ({
        id: b.id, candidateId: b.candidateId, vendor: b.vendor, status: b.status,
        reportRef: b.reportRef, notes: b.notes,
        initiatedBy: names.get(b.initiatedById) ?? null,
        initiatedAt: b.initiatedAt.toISOString(),
        completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      })),
    };
  });
}

/** Request a document from a candidate — idempotent upsert on
 * (candidateId, docTypeKey); a re-request after REJECTION resets the row. */
export async function requestDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(requestDocumentSchema, input);
    const [candidate, docType] = await Promise.all([
      db.candidate.findUnique({ where: { id: data.candidateId } }),
      db.documentTypeConfig.findUnique({ where: { key: data.docTypeKey } }),
    ]);
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (!docType || !docType.isActive) {
      throw new AuthorizationError("Unknown or inactive document type.");
    }

    const existing = await db.candidateDocument.findUnique({
      where: { candidateId_docTypeKey: { candidateId: candidate.id, docTypeKey: docType.key } },
    });
    let row;
    if (existing) {
      // Re-request: reset the flow (e.g. after a rejection or a re-send).
      row = await db.candidateDocument.update({
        where: { id: existing.id },
        data: {
          status: "REQUESTED",
          fileRef: "",
          receivedAt: null,
          verifiedById: "",
          verifiedAt: null,
          remarks: data.remarks,
          requestedAt: new Date(),
        },
      });
    } else {
      row = await db.candidateDocument.create({
        data: {
          candidateId: candidate.id,
          docTypeKey: docType.key,
          label: docType.label, // snapshot — renames don't rewrite history
          status: "REQUESTED",
          remarks: data.remarks,
        },
      });
    }
    await logAudit({
      actor: auth,
      action: "hiring.document_requested",
      entityType: "CANDIDATE_DOCUMENT",
      entityId: row.id,
      entityLabel: `${candidate.fullName} — ${docType.label}`,
      detail: `${auth.name} requested "${docType.label}" from ${candidate.fullName}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function receiveDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(receiveDocumentSchema, input);
    const doc = await db.candidateDocument.findUnique({
      where: { id: data.documentId },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (doc.status !== "REQUESTED" && doc.status !== "REJECTED") {
      throw new AuthorizationError(`Document is already ${doc.status}.`);
    }
    await db.candidateDocument.update({
      where: { id: doc.id },
      data: { status: "RECEIVED", fileRef: data.fileRef, receivedAt: new Date() },
    });
    await logAudit({
      actor: auth,
      action: "hiring.document_received",
      entityType: "CANDIDATE_DOCUMENT",
      entityId: doc.id,
      entityLabel: `${doc.candidate.fullName} — ${doc.label}`,
      detail: `${auth.name} marked "${doc.label}" received${data.fileRef ? ` (${data.fileRef})` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

export async function verifyDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(verifyDocumentSchema, input);
    const doc = await db.candidateDocument.findUnique({
      where: { id: data.documentId },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (doc.status !== "RECEIVED") {
      throw new AuthorizationError("Only a RECEIVED document can be verified.");
    }
    await db.candidateDocument.update({
      where: { id: doc.id },
      data: {
        status: "VERIFIED",
        remarks: data.remarks || doc.remarks,
        verifiedById: auth.userId,
        verifiedAt: new Date(),
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.document_verified",
      entityType: "CANDIDATE_DOCUMENT",
      entityId: doc.id,
      entityLabel: `${doc.candidate.fullName} — ${doc.label}`,
      detail: `${auth.name} verified "${doc.label}" for ${doc.candidate.fullName}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

export async function rejectDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(rejectDocumentSchema, input);
    const doc = await db.candidateDocument.findUnique({
      where: { id: data.documentId },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (doc.status !== "RECEIVED") {
      throw new AuthorizationError("Only a RECEIVED document can be rejected.");
    }
    await db.candidateDocument.update({
      where: { id: doc.id },
      data: { status: "REJECTED", remarks: data.remarks },
    });
    await logAudit({
      actor: auth,
      action: "hiring.document_rejected",
      entityType: "CANDIDATE_DOCUMENT",
      entityId: doc.id,
      entityLabel: `${doc.candidate.fullName} — ${doc.label}`,
      detail: `${auth.name} rejected "${doc.label}" — "${data.remarks}".`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

export async function initiateBackgroundCheck(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(initiateBackgroundCheckSchema, input);
    const candidate = await db.candidate.findUnique({ where: { id: data.candidateId } });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    const row = await db.backgroundCheck.create({
      data: {
        candidateId: candidate.id,
        vendor: data.vendor,
        notes: data.notes,
        initiatedById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.bg_check_initiated",
      entityType: "BACKGROUND_CHECK",
      entityId: row.id,
      entityLabel: `${candidate.fullName} — ${data.vendor}`,
      detail: `${auth.name} initiated a background check with "${data.vendor}" for ${candidate.fullName}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function updateBackgroundCheck(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(updateBackgroundCheckSchema, input);
    const check = await db.backgroundCheck.findUnique({
      where: { id: data.id },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!check) throw new AuthorizationError("Background check not found.");
    const terminal = data.status === "CLEARED" || data.status === "FLAGGED";
    await db.backgroundCheck.update({
      where: { id: check.id },
      data: {
        status: data.status,
        reportRef: data.reportRef || check.reportRef,
        notes: data.notes || check.notes,
        completedAt: terminal ? new Date() : null,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.bg_check_updated",
      entityType: "BACKGROUND_CHECK",
      entityId: check.id,
      entityLabel: `${check.candidate.fullName} — ${check.vendor}`,
      detail: `${auth.name} set the background check (${check.vendor}) for ${check.candidate.fullName} to ${data.status}${terminal ? " — completed" : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// R5 — offer builder (docs/RECRUITMENT_MODULE_PLAN.md §5). Templates are
// hiring:config; offers are hiring:manage and only for SELECTED candidates
// (the hire decision gates the offer, not the other way round). Components
// are stored as JSON and computed by lib/offer-math.ts.
// ---------------------------------------------------------------------------

function serializeOfferTemplate(t: {
  id: string; key: string; label: string; description: string;
  components: string; benefits: string; letterTemplate: string;
  isActive: boolean; sortOrder: number;
}): OfferTemplateT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    components: parseComponents(t.components),
    benefits: parseBenefits(t.benefits),
    letterTemplate: t.letterTemplate,
    isActive: t.isActive, sortOrder: t.sortOrder,
  };
}

/** List offer templates (hiring:manage — salary bands are sensitive). */
export async function getOfferTemplates(): Promise<ActionResult<OfferTemplateT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    const rows = await db.offerTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map(serializeOfferTemplate);
  });
}

export async function saveOfferTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(saveOfferTemplateSchema, input);
    const payload = {
      key: data.key,
      label: data.label,
      description: data.description,
      components: JSON.stringify(data.components),
      benefits: JSON.stringify(data.benefits),
      letterTemplate: data.letterTemplate,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    };
    const row = data.id
      ? await db.offerTemplate.update({ where: { id: data.id }, data: payload })
      : await db.offerTemplate.create({ data: payload });
    await logAudit({
      actor: auth,
      action: "hiring.offer_template_saved",
      entityType: "OFFER_TEMPLATE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} ${data.id ? "updated" : "created"} offer template "${row.label}" (${data.components.length} components).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function deleteOfferTemplate(input: { id: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(deleteOfferTemplateSchema, input);
    const row = await db.offerTemplate.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hiring.offer_template_deleted",
      entityType: "OFFER_TEMPLATE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} removed offer template "${row.label}" (existing offers keep their snapshots).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Generate an offer for a SELECTED candidate from a template: components +
 * benefits are copied (the template snapshot), the letter is rendered with
 * the candidate's numbers. Status DRAFT — editable until sent (R6). */
export async function createOfferRecord(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(createOfferRecordSchema, input);
    const [candidate, template] = await Promise.all([
      db.candidate.findUnique({ where: { id: data.candidateId } }),
      db.offerTemplate.findUnique({ where: { id: data.templateId } }),
    ]);
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.status !== "SELECTED") {
      throw new AuthorizationError("Offers can only be created for SELECTED candidates.");
    }
    if (!template || !template.isActive) {
      throw new AuthorizationError("Unknown or inactive offer template.");
    }
    const components = parseComponents(template.components);
    const benefits = parseBenefits(template.benefits);
    const config = await getWorkspaceConfig();
    const totals = computeOffer(components);
    const letterText = renderOfferLetter(
      template.letterTemplate,
      {
        candidateName: candidate.fullName,
        position: candidate.position,
        workspaceName: config.workspace.name,
      },
      totals,
    );
    const row = await db.offerRecord.create({
      data: {
        candidateId: candidate.id,
        templateId: template.id,
        templateLabel: template.label,
        components: JSON.stringify(components),
        benefits: JSON.stringify(benefits),
        letterText,
        status: "DRAFT",
        notes: data.notes,
        createdById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.offer_created",
      entityType: "OFFER_RECORD",
      entityId: row.id,
      entityLabel: `${candidate.fullName} — ${template.label}`,
      detail: `${auth.name} generated a draft offer for ${candidate.fullName} from "${template.label}" (CTC ${formatMoney(totals.ctc)}).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Edit a DRAFT offer's negotiated numbers / benefits / letter. Once sent
 * (R6) the record is immutable — the signed snapshot is the contract. */
export async function updateOfferRecord(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(updateOfferRecordSchema, input);
    const offer = await db.offerRecord.findUnique({
      where: { id: data.id },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("Offer not found.");
    if (offer.status !== "DRAFT") {
      throw new AuthorizationError(`Offer is already ${offer.status} — sent offers are immutable.`);
    }
    await db.offerRecord.update({
      where: { id: offer.id },
      data: {
        components: JSON.stringify(data.components),
        benefits: JSON.stringify(data.benefits),
        letterText: data.letterText,
        notes: data.notes,
      },
    });
    const totals = computeOffer(data.components);
    await logAudit({
      actor: auth,
      action: "hiring.offer_updated",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${auth.name} updated the draft offer for ${offer.candidate.fullName} (CTC ${formatMoney(totals.ctc)}).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** All offers, newest first (hiring:manage) — the Offers panel. */
export async function getOfferRecords(): Promise<ActionResult<OfferRecordT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    const rows = await db.offerRecord.findMany({
      include: { candidate: { select: { fullName: true, position: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const names = await namesFor(rows.map((r) => r.createdById));
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidateId,
      candidateName: r.candidate.fullName,
      position: r.candidate.position,
      templateId: r.templateId,
      templateLabel: r.templateLabel,
      components: parseComponents(r.components),
      benefits: parseBenefits(r.benefits),
      letterText: r.letterText,
      status: r.status,
      notes: r.notes,
      createdBy: names.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      // R6 e-sign fields — the token lets HR re-copy the signing link (the
      // action is already hiring:manage gated); signedName/At power the
      // "signed by" display on SENT → SIGNED records.
      token: r.token,
      tokenExpiresAt: r.tokenExpiresAt ? r.tokenExpiresAt.toISOString() : null,
      signedAt: r.signedAt ? r.signedAt.toISOString() : null,
      signedName: r.signedName,
    }));
  });
}

// ---------------------------------------------------------------------------
// R6 — e-sign + auto employee creation (docs/RECRUITMENT_MODULE_PLAN.md §5).
// Flow: sendOffer (hiring:manage) mints a single-use token + emails the
// signing link via the outbox; the candidate opens the PUBLIC /offer/[token]
// page (no session) and either signs (typed full name → immutable snapshot
// with IP + timestamp) or declines; markJoined then creates the User account
// (deterministic <first>.<last>@domain email), EmployeeProfile, TeamMember
// roster entry, onboarding checklist, and queues a welcome email.
// ---------------------------------------------------------------------------

const OFFER_TOKEN_TTL_DAYS = 7;

function generateOfferToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function offerBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";
}

/** The deterministic account email for a joining hire:
 * <first>.<last>@hiringEmailDomain, lowercased ASCII; collisions get a
 * numeric suffix (priyanka.menon2@…). */
function buildHireEmail(fullName: string, domain: string): string {
  const parts = fullName.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").split(".");
  const handle = parts.slice(0, 2).join(".") || "new.hire";
  return `${handle}@${domain}`;
}

async function nextAvailableHireEmail(fullName: string, domain: string): Promise<string> {
  const base = buildHireEmail(fullName, domain);
  let candidate = base;
  let n = 2;
  // Small workspaces: a linear probe is plenty; the unique constraint is the
  // final guard inside the transaction.
  while (true) {
    const existing = await db.user.findUnique({ where: { email: candidate }, select: { id: true } });
    if (!existing) return candidate;
    const [handle, dom] = base.split("@");
    candidate = `${handle}${n}@${dom}`;
    n += 1;
  }
}

export async function sendOffer(input: { offerId: string }): Promise<ActionResult<{ token: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const offerId = String(input?.offerId ?? "").trim();
    if (!offerId) throw new AuthorizationError("An offer id is required.");
    const offer = await db.offerRecord.findUnique({
      where: { id: offerId },
      include: { candidate: { select: { id: true, fullName: true, email: true, position: true, status: true } } },
    });
    if (!offer) throw new AuthorizationError("Offer not found.");
    if (offer.status !== "DRAFT") {
      throw new AuthorizationError(`Offer is already ${offer.status}.`);
    }
    if (offer.candidate.status !== "SELECTED") {
      throw new AuthorizationError("Offers can only be sent to SELECTED candidates.");
    }

    const token = generateOfferToken();
    const tokenExpiresAt = new Date(Date.now() + OFFER_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.offerRecord.update({
      where: { id: offer.id },
      data: { status: "SENT", token, tokenExpiresAt },
    });

    // Email the signing link via the audited outbox (best-effort like the
    // rejection email; a provider outage never fails the send itself).
    const config = await getWorkspaceConfig();
    const link = `${offerBaseUrl()}/offer/${token}`;
    const totals = computeOffer(parseComponents(offer.components));
    const subject = `Your offer from ${config.workspace.name} — ${offer.candidate.position || "the role"}`;
    const text =
      `Hi ${offer.candidate.fullName.split(/\s+/)[0]},\n\n` +
      `Please review and sign your offer from ${config.workspace.name}:\n\n${link}\n\n` +
      `Total package: ${formatMoney(totals.ctc)} per year (net ${formatMoney(totals.net)}).\n` +
      `The link expires in ${OFFER_TOKEN_TTL_DAYS} days and can be used once.\n\n` +
      `We are looking forward to having you on the team!\n\nThe ${config.workspace.name} Hiring Team`;
    const html =
      `<p>Hi ${escapeHtml(offer.candidate.fullName.split(/\s+/)[0])},</p>` +
      `<p>Please review and sign your offer from ${escapeHtml(config.workspace.name)}:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p>Total package: <strong>${formatMoney(totals.ctc)}</strong> per year (net ${formatMoney(totals.net)}).</p>` +
      `<p>The link expires in ${OFFER_TOKEN_TTL_DAYS} days and can be used once.</p>` +
      `<p>We are looking forward to having you on the team!</p>` +
      `<p>The ${escapeHtml(config.workspace.name)} Hiring Team</p>`;

    const row = await db.mailOutbox.create({
      data: {
        kind: "OFFER",
        candidateId: offer.candidateId,
        toAddress: offer.candidate.email,
        subject,
        body: text,
        status: "QUEUED",
        sentById: auth.userId,
      },
    });
    let status = "SKIPPED";
    let providerMessageId = "";
    let error = "";
    try {
      const result = await createMailer().sendMail({ to: offer.candidate.email, subject, html, text });
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
      data: { status, providerMessageId, error, sentAt: new Date() },
    });

    await logAudit({
      actor: auth,
      action: "hiring.offer_sent",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${auth.name} sent the offer to ${offer.candidate.email} (signing link expires in ${OFFER_TOKEN_TTL_DAYS} days; email ${status}).`,
    });
    revalidatePath("/");
    return { token };
  });
}

/** Public (no session): the candidate's view of a tokenized offer. Never
 * exposes internal notes or the outbox; only the letter + numbers.
 *
 * `state` mirrors the token's lifecycle: OPEN (signable), or SIGNED /
 * DECLINED after the single use — those CONSUMED states still return the
 * payload (with signedAt/signedName where relevant) so revisiting the link
 * shows the candidate their own recorded outcome instead of a dead-end
 * error. Genuinely unopenable links (unknown token, expired, not yet sent)
 * still throw user-friendly errors. */
export async function getOfferByToken(
  token: string,
): Promise<ActionResult<{
  state: "OPEN" | "SIGNED" | "DECLINED";
  offerId: string;
  candidateName: string;
  position: string;
  workspaceName: string;
  templateLabel: string;
  letterText: string;
  components: { key: string; label: string; kind: string; mode: string; amount: number; resolved: number }[];
  benefits: string[];
  totals: { earnings: number; employerContributions: number; deductions: number; net: number; ctc: number };
  expiresAt: string;
  signedAt: string | null;
  signedName: string | null;
}>> {
  return toResult(async () => {
    const t = String(token ?? "").trim();
    if (!t) throw new AuthorizationError("A token is required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { fullName: true, position: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status !== "SENT" && offer.status !== "SIGNED" && offer.status !== "DECLINED") {
      throw new AuthorizationError("This offer is not available for signing yet.");
    }
    if (offer.status === "SENT" && offer.tokenExpiresAt && offer.tokenExpiresAt.getTime() < Date.now()) {
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    const components = parseComponents(offer.components);
    const totals = computeOffer(components);
    const config = await getWorkspaceConfig();
    return {
      state: offer.status === "SIGNED" ? "SIGNED" : offer.status === "DECLINED" ? "DECLINED" : "OPEN",
      offerId: offer.id,
      candidateName: offer.candidate.fullName,
      position: offer.candidate.position,
      workspaceName: config.workspace.name,
      templateLabel: offer.templateLabel,
      letterText: offer.letterText,
      components: components.map((c) => ({ ...c, resolved: totals.resolved[c.key] ?? 0 })),
      benefits: parseBenefits(offer.benefits),
      totals: {
        earnings: totals.earnings,
        employerContributions: totals.employerContributions,
        deductions: totals.deductions,
        net: totals.net,
        ctc: totals.ctc,
      },
      expiresAt: (offer.tokenExpiresAt ?? new Date()).toISOString(),
      signedAt: offer.signedAt ? offer.signedAt.toISOString() : null,
      signedName: offer.signedName || null,
    };
  });
}

/** Public (no session): typed-signature capture. The typed name must match
 * the candidate's full name (case-insensitive) — the ceremony that makes the
 * signature deliberate. Records signedAt + source IP; the record becomes
 * immutable (updateOfferRecord refuses non-DRAFT states). */
export async function signOffer(input: {
  token: string;
  signedName: string;
}): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const t = String(input?.token ?? "").trim();
    const signedName = String(input?.signedName ?? "").trim();
    if (!t || !signedName) throw new AuthorizationError("A token and your full name are required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { id: true, fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status !== "SENT") throw new AuthorizationError(`This offer is ${offer.status}.`);
    if (offer.tokenExpiresAt && offer.tokenExpiresAt.getTime() < Date.now()) {
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    if (signedName.toLowerCase() !== offer.candidate.fullName.toLowerCase()) {
      throw new AuthorizationError("Please type your full legal name exactly as it appears on the offer.");
    }
    // Best-effort client IP (behind the reverse proxy), like password-reset.
    let ip = "unknown";
    try {
      const h = await headers();
      const xff = h.get("x-forwarded-for") ?? "";
      ip = xff.split(",")[0].trim() || "unknown";
    } catch {
      ip = "unknown";
    }
    await db.offerRecord.update({
      where: { id: offer.id },
      data: { status: "SIGNED", signedAt: new Date(), signedName, signedIp: ip },
    });
    await logAudit({
      actor: { userId: `candidate:${offer.candidateId}`, name: signedName, role: "CANDIDATE" },
      action: "hiring.offer_signed",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${signedName} signed the offer (IP ${ip}).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Public (no session): decline without signing. */
export async function declineOffer(input: { token: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const t = String(input?.token ?? "").trim();
    if (!t) throw new AuthorizationError("A token is required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { id: true, fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status !== "SENT") throw new AuthorizationError(`This offer is ${offer.status}.`);
    await db.offerRecord.update({ where: { id: offer.id }, data: { status: "DECLINED" } });
    await logAudit({
      actor: { userId: `candidate:${offer.candidateId}`, name: offer.candidate.fullName, role: "CANDIDATE" },
      action: "hiring.offer_declined",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${offer.candidate.fullName} declined the offer.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Mark a signed candidate as Joined: creates the employee's account
 * (deterministic email), EmployeeProfile, roster entry, and onboarding
 * checklist, then queues the welcome email. Idempotent per candidate. */
export async function markJoined(input: { candidateId: string }): Promise<ActionResult<{ userId: string; email: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const candidateId = String(input?.candidateId ?? "").trim();
    if (!candidateId) throw new AuthorizationError("A candidate id is required.");
    const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.userId) {
      throw new AuthorizationError(`${candidate.fullName} already joined (account exists).`);
    }
    if (candidate.status !== "SELECTED") {
      throw new AuthorizationError("Only selected candidates can be marked as joined.");
    }
    const signedOffer = await db.offerRecord.findFirst({
      where: { candidateId: candidate.id, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
    });
    if (!signedOffer) {
      throw new AuthorizationError("The candidate must sign their offer before joining (no SIGNED offer found).");
    }

    const config = await getWorkspaceConfig();
    const domain = (config as { workspace: { hiringEmailDomain?: string } }).workspace.hiringEmailDomain || "fernly.app";
    const email = await nextAvailableHireEmail(candidate.fullName, domain);
    // Random one-time password — never emailed; the hire sets their own via
    // the existing password-reset flow (welcome mail points them there).
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString("base64url"));

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: candidate.fullName,
          passwordHash,
          role: "MEMBER",
        },
      });
      await tx.teamMember.create({
        data: {
          name: candidate.fullName,
          role: "MEMBER",
          department: candidate.department || config.workspace.defaultDepartment,
          email,
          userId: created.id,
        },
      });
      await tx.employeeProfile.create({
        data: {
          userId: created.id,
          jobTitle: candidate.position || "",
          department: candidate.department || "",
          hireDate: new Date(),
        },
      });
      // The standard onboarding checklist (mirrors hr-onboarding's template).
      await tx.onboardingChecklist.create({
        data: {
          newHireId: created.id,
          title: `${candidate.fullName} — onboarding`,
          tasks: {
            create: [
              { title: "Sign the employment contract", dueOffsetDays: 1, order: 0 },
              { title: "Set up accounts and SSO access", dueOffsetDays: 2, order: 1 },
              { title: "Meet your manager for the 1:1 kick-off", dueOffsetDays: 3, order: 2 },
              { title: "Complete the workspace tour", dueOffsetDays: 5, assigneeId: created.id, order: 3 },
              { title: "First small task shipped with a mentor", dueOffsetDays: 14, assigneeId: created.id, order: 4 },
            ],
          },
        },
      });
      await tx.candidate.update({
        where: { id: candidate.id },
        data: { status: "HIRED", userId: created.id, joinedAt: new Date() },
      });
      return created;
    });

    // Welcome email → outbox (best-effort).
    const first = candidate.fullName.split(/\s+/)[0];
    const subject = `Welcome to ${config.workspace.name}, ${first}!`;
    const text =
      `Hi ${first},\n\n` +
      `Welcome aboard! Your account email is ${email}.\n` +
      `To set your password, open the app and use "Forgot password?" with that email.\n\n` +
      `Your onboarding checklist is waiting in the app — see you on day one!\n\n` +
      `The ${config.workspace.name} team`;
    const html =
      `<p>Hi ${escapeHtml(first)},</p>` +
      `<p>Welcome aboard! Your account email is <strong>${escapeHtml(email)}</strong>.</p>` +
      `<p>To set your password, open the app and use "Forgot password?" with that email.</p>` +
      `<p>Your onboarding checklist is waiting in the app — see you on day one!</p>` +
      `<p>The ${escapeHtml(config.workspace.name)} team</p>`;
    const row = await db.mailOutbox.create({
      data: {
        kind: "WELCOME",
        candidateId: candidate.id,
        toAddress: email,
        subject,
        body: text,
        status: "QUEUED",
        sentById: auth.userId,
      },
    });
    let wstatus = "SKIPPED";
    let wprovider = "";
    let werror = "";
    try {
      const result = await createMailer().sendMail({ to: email, subject, html, text });
      if (result.delivered) {
        wstatus = "SENT";
        wprovider = result.messageId ?? "";
      }
    } catch (err) {
      wstatus = "FAILED";
      werror = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    }
    await db.mailOutbox.update({
      where: { id: row.id },
      data: { status: wstatus, providerMessageId: wprovider, error: werror, sentAt: new Date() },
    });

    await logAudit({
      actor: auth,
      action: "hiring.candidate_joined",
      entityType: "CANDIDATE",
      entityId: candidate.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} marked "${candidate.fullName}" as joined — account ${email} created with onboarding checklist + welcome email (${wstatus}).`,
    });
    revalidatePath("/");
    return { userId: user.id, email };
  });
}
