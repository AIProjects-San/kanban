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
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import type { CandidateT, CandidateStageT, HiringStageConfigT } from "@/lib/types";
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

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type StageRow = {
  id: string; candidateId: string; stageKey: string; label: string;
  stageType: string; ownerUserId: string | null; status: string;
  scheduledAt: Date | null; remarks: string; rating: number | null;
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
// Decisions (hiring:manage) — REJECT / WITHDRAW / REACTIVATE.
// The rejection email (custom remarks) arrives with R3's outbox; R1 stores
// the reason, which is the merge source for that email.
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
      if (candidate.status !== "REJECTED" && candidate.status !== "WITHDRAWN") {
        throw new AuthorizationError("Only rejected or withdrawn candidates can be reactivated.");
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
    }
    revalidatePath("/");
    return { ok: true };
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
  ActionResult<{ canManage: boolean; canConfig: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:view");
    const canManage = hasPermission(auth.role, "hiring:manage");
    const canConfig = hasPermission(auth.role, "hiring:config");
    return { canManage, canConfig };
  });
}
