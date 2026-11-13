"use server";

// ---------------------------------------------------------------------------
// P36 (EM-21, EM-B08) — employee identification documents
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P36).
//
// The benchmark's Identification Document Type is a doc-type master FOR
// EMPLOYEE identification; Fernly's DocumentTypeConfig was candidate-side
// only. This module owns the employee half: the scope-gated master read,
// the EmployeeDocument lifecycle and the member self-service submission.
//
// Lifecycle: REQUESTED → RECEIVED → VERIFIED | REJECTED (a re-request
// after a REJECTION resets the row). fileRef is a reference (URL / file
// name) — no binary upload infra in v1 (the CandidateDocument convention).
//
// RBAC:
//   reads             — hr:view (HR console panel) / the member themself
//                       (their own rows, the Settings self-service section)
//   request / verify  — hr:admin (the chase and the decision are HR's)
//   submit (RECEIVED) — the member themself OR hr:admin (whoever holds
//                       the passport in their hand)
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, checkPermission, AuthorizationError } from "./auth-guard";
import {
  requestEmployeeDocumentSchema,
  submitEmployeeDocumentSchema,
  verifyEmployeeDocumentSchema,
  rejectEmployeeDocumentSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { DocumentTypeConfigT, EmployeeDocumentT } from "@/lib/types";
import {
  canRequestEmployeeDocument,
  canSubmitEmployeeDocument,
  canDecideEmployeeDocument,
  employeeDocumentSummary,
} from "@/lib/hr/employee-documents";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The EMPLOYEE-scope doc types (the identification master — hr:view). */
export async function getEmployeeDocTypes(): Promise<ActionResult<DocumentTypeConfigT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const rows = await db.documentTypeConfig.findMany({
      where: { scope: "EMPLOYEE" },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map(serialize);
  });
}

function serialize(t: {
  id: string; key: string; label: string; description: string;
  isMandatory: boolean; scope: string; sortOrder: number; isActive: boolean;
}): DocumentTypeConfigT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    isMandatory: t.isMandatory,
    scope: t.scope === "EMPLOYEE" ? "EMPLOYEE" : "CANDIDATE",
    sortOrder: t.sortOrder, isActive: t.isActive,
  };
}

/** One employee's identification documents + the summary line + the
 *  employee-scope type master (hr:view for any employee; a member reading
 *  their own gets their rows with canManage false). */
export async function getEmployeeDocuments(input: {
  userId?: string;
}): Promise<ActionResult<{
  documents: EmployeeDocumentT[];
  docTypes: DocumentTypeConfigT[];
  summary: string;
  canManage: boolean;
}>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const isSelf = !input.userId || input.userId === auth.userId;
    const canManage = await checkPermission(auth.role, "hr:view");
    if (!isSelf && !canManage) {
      throw new AuthorizationError("You can only view your own identification documents.");
    }
    const userId = isSelf ? auth.userId : input.userId!;
    const [docs, types] = await Promise.all([
      db.employeeDocument.findMany({ where: { userId }, orderBy: { requestedAt: "asc" } }),
      db.documentTypeConfig.findMany({
        where: { scope: "EMPLOYEE", isActive: true },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      }),
    ]);
    const typeBykey = new Map(types.map((t) => [t.key, t]));
    const names = new Map<string, string>();
    if (!isSelf || docs.some((d) => d.verifiedById)) {
      const ids = [...new Set([userId, ...docs.map((d) => d.verifiedById).filter(Boolean)])];
      const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      for (const u of users) names.set(u.id, u.name);
    } else {
      const me = await db.user.findUnique({ where: { id: auth.userId }, select: { name: true } });
      if (me) names.set(auth.userId, me.name);
    }
    const documents: EmployeeDocumentT[] = docs.map((d) => ({
      id: d.id,
      userId: d.userId,
      userName: names.get(d.userId) ?? "(former user)",
      docTypeKey: d.docTypeKey,
      label: d.label,
      status: d.status as EmployeeDocumentT["status"],
      fileRef: d.fileRef,
      remarks: d.remarks,
      requestedAt: d.requestedAt.toISOString(),
      receivedAt: d.receivedAt ? d.receivedAt.toISOString() : null,
      verifiedBy: d.verifiedById ? names.get(d.verifiedById) ?? null : null,
      verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
      isMandatory: typeBykey.get(d.docTypeKey)?.isMandatory ?? false,
    }));
    return {
      documents,
      docTypes: types.map(serialize),
      summary: employeeDocumentSummary(documents).summary,
      canManage,
    };
  });
}

// ---------------------------------------------------------------------------
// The lifecycle (P36/EM-21)
// ---------------------------------------------------------------------------

/** HR requests an identification document from an employee — idempotent
 *  upsert on (userId, docTypeKey); a re-request after REJECTION resets the
 *  row; a VERIFIED row is history and refuses. The doc type must be
 *  EMPLOYEE-scoped (an identification type never rides the joining gate). */
export async function requestEmployeeDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(requestEmployeeDocumentSchema, input);
    const [employee, docType] = await Promise.all([
      db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true, deletedAt: true } }),
      db.documentTypeConfig.findUnique({ where: { key: data.docTypeKey } }),
    ]);
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");
    if (!docType || !docType.isActive) {
      throw new AuthorizationError("Unknown or inactive document type.");
    }
    if (docType.scope !== "EMPLOYEE") {
      throw new AuthorizationError("That document type is for candidates, not employee identification.");
    }
    const existing = await db.employeeDocument.findUnique({
      where: { userId_docTypeKey: { userId: employee.id, docTypeKey: docType.key } },
    });
    if (existing && !canRequestEmployeeDocument(existing.status)) {
      throw new AuthorizationError(`That document is already ${existing.status} — history is not reopened.`);
    }
    const row = existing
      ? await db.employeeDocument.update({
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
        })
      : await db.employeeDocument.create({
          data: {
            userId: employee.id,
            docTypeKey: docType.key,
            label: docType.label, // snapshot — renames don't rewrite history
            status: "REQUESTED",
            remarks: data.remarks,
          },
        });
    await logAudit({
      actor: auth,
      action: "hr.employee_document_requested",
      entityType: "EMPLOYEE_DOCUMENT",
      entityId: row.id,
      entityLabel: `${employee.name} — ${docType.label}`,
      detail: `${auth.name} requested "${docType.label}" from ${employee.name}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Mark a document RECEIVED — the member themself (the self-service
 *  submission: they hold the passport) or any hr:admin holder. */
export async function submitEmployeeDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const data = parseOrThrow(submitEmployeeDocumentSchema, input);
    const doc = await db.employeeDocument.findUnique({ where: { id: data.documentId } });
    if (!doc) throw new AuthorizationError("Document not found.");
    const isOwner = doc.userId === auth.userId;
    const canManage = await checkPermission(auth.role, "hr:admin");
    if (!isOwner && !canManage) {
      throw new AuthorizationError("Only the employee themself or HR can submit this document.");
    }
    if (!canSubmitEmployeeDocument(doc.status)) {
      throw new AuthorizationError(`Document is already ${doc.status}.`);
    }
    await db.employeeDocument.update({
      where: { id: doc.id },
      data: { status: "RECEIVED", fileRef: data.fileRef, receivedAt: new Date() },
    });
    await logAudit({
      actor: auth,
      action: "hr.employee_document_submitted",
      entityType: "EMPLOYEE_DOCUMENT",
      entityId: doc.id,
      entityLabel: doc.label,
      detail: `${auth.name} marked "${doc.label}" received${data.fileRef ? ` (${data.fileRef})` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** HR verifies a RECEIVED document (terminal). */
export async function verifyEmployeeDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(verifyEmployeeDocumentSchema, input);
    const doc = await db.employeeDocument.findUnique({ where: { id: data.documentId } });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (!canDecideEmployeeDocument(doc.status)) {
      throw new AuthorizationError("Only a RECEIVED document can be verified.");
    }
    await db.employeeDocument.update({
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
      action: "hr.employee_document_verified",
      entityType: "EMPLOYEE_DOCUMENT",
      entityId: doc.id,
      entityLabel: doc.label,
      detail: `${auth.name} verified "${doc.label}".`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** HR rejects a RECEIVED document — a note is required (the member needs
 *  to know what to fix); a re-request resets the row afterwards. */
export async function rejectEmployeeDocument(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(rejectEmployeeDocumentSchema, input);
    const doc = await db.employeeDocument.findUnique({ where: { id: data.documentId } });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (!canDecideEmployeeDocument(doc.status)) {
      throw new AuthorizationError("Only a RECEIVED document can be rejected.");
    }
    await db.employeeDocument.update({
      where: { id: doc.id },
      data: { status: "REJECTED", remarks: data.remarks },
    });
    await logAudit({
      actor: auth,
      action: "hr.employee_document_rejected",
      entityType: "EMPLOYEE_DOCUMENT",
      entityId: doc.id,
      entityLabel: doc.label,
      detail: `${auth.name} rejected "${doc.label}": ${data.remarks}`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}
