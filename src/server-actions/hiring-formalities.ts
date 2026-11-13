"use server";

// ---------------------------------------------------------------------------
// R4 — joining formalities: document checklist + background checks (split
// from hiring.ts). All manage ops are hiring:manage; the checklist template
// editor is hiring:config. Documents reference DocumentTypeConfig by KEY;
// the label is snapshotted at request time so template renames never orphan
// candidate history.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { DocumentTypeConfigT, CandidateDocumentT, BackgroundCheckT } from "@/lib/types";
import {
  saveDocumentTypeSchema,
  deleteDocumentTypeSchema,
  requestDocumentSchema,
  receiveDocumentSchema,
  verifyDocumentSchema,
  rejectDocumentSchema,
  initiateBackgroundCheckSchema,
  updateBackgroundCheckSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { evaluateJoiningGate } from "@/lib/hiring/joining-gate";
import { namesFor } from "@/lib/hiring/user-names";

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
  isMandatory: boolean; scope: string; sortOrder: number; isActive: boolean;
}): DocumentTypeConfigT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    isMandatory: t.isMandatory,
    // P36 — the scope axis (pre-P36 rows read CANDIDATE, their meaning).
    scope: t.scope === "EMPLOYEE" ? "EMPLOYEE" : "CANDIDATE",
    sortOrder: t.sortOrder, isActive: t.isActive,
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
  /** F2.10 (F-R9/E5) — the joining-gate verdict for THIS candidate: what
   * markJoined will enforce, rendered before it bites. */
  gate: { enabled: boolean; allowed: boolean; blockers: string[]; summary: string };
}>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    const [docTypes, documents, bgChecks, config] = await Promise.all([
      // P36 — the gate applies CANDIDATE-scope mandatory types only: an
      // EMPLOYEE-scope identification type never blocks a join.
      db.documentTypeConfig.findMany({ where: { scope: "CANDIDATE" }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] }),
      db.candidateDocument.findMany({
        where: { candidateId },
        orderBy: { requestedAt: "asc" },
      }),
      db.backgroundCheck.findMany({
        where: { candidateId },
        orderBy: { initiatedAt: "desc" },
      }),
      getWorkspaceConfig(),
    ]);
    const names = await namesFor([
      ...documents.map((d) => d.verifiedById),
      ...bgChecks.map((b) => b.initiatedById),
    ]);
    // F2.10 — the same pure rule markJoined enforces (when the gate is on).
    const evaluation = evaluateJoiningGate({ docTypes, documents, bgChecks });
    return {
      gate: {
        enabled: config.workspace.joiningGateEnabled,
        allowed: !config.workspace.joiningGateEnabled || evaluation.allowed,
        blockers: evaluation.blockers,
        summary: evaluation.summary,
      },
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
