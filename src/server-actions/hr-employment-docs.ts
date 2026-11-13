"use server";

// ---------------------------------------------------------------------------
// P1 G6 — the Employee Transfer / Employee Promotion server actions.
//
// The document lifecycle (spec §2):
//   create*  → DRAFT            (hr:admin — the HR-console audience)
//   submit   → PENDING_APPROVAL (hr:admin; the effective date must be in
//                                the future — spec §4)
//   approve  → APPROVED         (hr:admin + four-eyes: the approver is
//                                neither the creator nor the subject —
//                                spec §4 "cannot approve your own")
//   cancel   → CANCELLED        (the creator before EFFECTIVE; ADMIN as the
//                                safety valve for an orphaned APPROVED doc)
//   effect   → EFFECTIVE        (hr:admin, on/after the effective date —
//                                delegates to the ONE effect core in
//                                lib/hr/employment-doc-effect.ts, which the
//                                daily sweep also rides)
//
// Discipline carried from the leave chain (the codebase's approval-flow
// convention — there is no shared generic state machine; each document
// family owns its graph in a pure kernel beside its actions):
//   • guarded status-in-WHERE updateMany flips (QA-16 — two concurrent
//     approvers cannot both win);
//   • toResult/ActionResult wrappers with AuthorizationError refusals;
//   • one audit entry per transition, diff in the detail line;
//   • no employment-fact write before EFFECTIVE (the effect core is the
//     ONLY writer of profile facts / manager / property history).
//
// Readers are hr:view (the getEmploymentHistory convention); writers are
// hr:admin (the applyEmploymentChange convention).
//
// URL note: the (hr-admin) route group is stripped — the pages live at
// /admin/employees/[id]/transfers and /admin/employees/[id]/promotions,
// which the revalidatePath calls name.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import {
  parseOrThrow,
  createEmployeeTransferSchema,
  createEmployeePromotionSchema,
  employmentDocumentRefSchema,
  cancelEmploymentDocumentSchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { assertNoCycle } from "@/lib/auth/hierarchy";
import {
  isFutureDay,
  utcDayKeyOf,
  dayKeyToDate,
  transferCarriesAnyAxis,
  transferChangesAnyFact,
  promotionChangesAnyFact,
  CANCELABLE_EMPLOYMENT_DOC_STATUSES,
  EMPLOYMENT_DOC_STATUS_LABELS,
  type EmploymentDocStatus,
} from "@/lib/hr/employment-documents";
import { effectEmploymentDocument } from "@/lib/hr/employment-doc-effect";
import type { EmployeeTransferT, EmployeePromotionT } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

interface AuthCtx {
  userId: string;
  role: string;
  name: string;
  email: string;
}

/** The manager-axis storage encoding — the nullable column must carry
 * THREE input meanings, so absent-vs-clear is disambiguated by "":
 *   input undefined (keep)  → stored null  (the effect core skips it)
 *   input null/""  (clear)  → stored ""    (the effect core clears the line)
 *   input "<id>"   (set)    → stored "<id>" (the effect core sets it)
 * The predicate + effect core normalize both sides before comparing. */
function storeManagerId(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return input === undefined ? null : "";
  return input === "" ? "" : input;
}

/** Normalize a manager ref for comparison: undefined = absent, null = clear,
 * both "" and null on the stored side read as "clear". */
function compareManagerId(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  return input || null;
}

/** Load the employee + profile pair every writer needs (the profile may be
 * null — the profile-less member is legal, QA-19's "" starting state). */
async function loadEmployee(userId: string) {
  const targetUserId = String(userId ?? "").trim();
  if (!targetUserId) throw new AuthorizationError("A user id is required.");
  const user = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, email: true, deletedAt: true, managerId: true },
  });
  if (!user || user.deletedAt) throw new AuthorizationError("Employee not found.");
  const profile = await db.employeeProfile.findUnique({ where: { userId: targetUserId } });
  if ((profile?.employmentStatus ?? "") === "EXITED") {
    throw new AuthorizationError(
      `${user.name} has exited — employment changes are settled by the full-and-final, never re-opened.`,
    );
  }
  return { user, profile };
}

/** Resolve display names for a set of user ids (creators, approvers,
 * managers) in one query — null for unknown/deleted ids. */
async function nameMapOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

function revalidateEmployeePages(employeeId: string) {
  revalidatePath("/");
  revalidatePath(`/admin/employees/${employeeId}/transfers`);
  revalidatePath(`/admin/employees/${employeeId}/promotions`);
}

// ---------------------------------------------------------------------------
// Create — the DRAFT documents (from-side snapshotted from the live facts).
// ---------------------------------------------------------------------------

export async function createEmployeeTransfer(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(createEmployeeTransferSchema, input);
    const { user, profile } = await loadEmployee(data.employeeId);

    // Spec §4 — the named refusals: same department / same designation.
    const currentDepartment = profile?.department ?? "";
    const currentJobTitle = profile?.jobTitle ?? "";
    if (data.toDepartment !== undefined && data.toDepartment === currentDepartment) {
      throw new AuthorizationError(
        `${user.name} is already in that department — a transfer must move them somewhere else.`,
      );
    }
    if (data.toJobTitle !== undefined && data.toJobTitle === currentJobTitle) {
      throw new AuthorizationError(
        `${user.name} already holds that job title — a transfer must change it (or leave it untouched).`,
      );
    }
    if (!transferCarriesAnyAxis(data)) {
      throw new AuthorizationError(
        "A transfer needs at least one destination — pick a department, job title, manager or location.",
      );
    }

    // The manager target (null = an explicit clear of the reporting line;
    // undefined = untouched — the storage encoding above).
    if (data.toManagerId !== undefined && data.toManagerId !== null && data.toManagerId !== "") {
      if (data.toManagerId === user.id) {
        throw new AuthorizationError("A member cannot report to themselves.");
      }
      const mgr = await db.user.findUnique({
        where: { id: data.toManagerId },
        select: { id: true, deletedAt: true },
      });
      if (!mgr || mgr.deletedAt) {
        throw new AuthorizationError("Manager not found — pick a current member.");
      }
      await assertNoCycle(user.id, data.toManagerId);
    }

    // The weaker rule for the un-named axes: at least one fact must move.
    if (
      !transferChangesAnyFact(
        {
          department: currentDepartment,
          jobTitle: currentJobTitle,
          grade: profile?.grade ?? "",
          location: profile?.location ?? "",
          managerId: user.managerId ?? null,
        },
        {
          toDepartment: data.toDepartment,
          toJobTitle: data.toJobTitle,
          toManagerId: compareManagerId(data.toManagerId),
          toLocation: data.toLocation,
        },
      )
    ) {
      throw new AuthorizationError(
        "Nothing changes — pick at least one destination that differs from the current facts.",
      );
    }

    const created = await db.employeeTransfer.create({
      data: {
        employeeId: user.id,
        fromDepartment: currentDepartment || null,
        fromJobTitle: currentJobTitle || null,
        fromManagerId: user.managerId ?? null,
        fromLocation: profile?.location || null,
        toDepartment: data.toDepartment ?? null,
        toJobTitle: data.toJobTitle ?? null,
        toManagerId: storeManagerId(data.toManagerId),
        toLocation: data.toLocation ?? null,
        effectiveDate: dayKeyToDate(data.effectiveDate),
        reason: data.reason ?? null,
        status: "DRAFT",
        createdById: auth.userId,
      },
      select: { id: true },
    });

    await logAudit({
      actor: auth,
      action: "hr.transfer_created",
      entityType: "EMPLOYEE_TRANSFER",
      entityId: created.id,
      entityLabel: user.name,
      detail:
        `${auth.name} drafted a transfer for ${user.name} effective ${data.effectiveDate}` +
        `${data.reason ? ` (reason: ${data.reason})` : ""}.`,
    });
    revalidateEmployeePages(user.id);
    return { id: created.id };
  });
}

export async function createEmployeePromotion(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(createEmployeePromotionSchema, input);
    const { user, profile } = await loadEmployee(data.employeeId);

    // Spec §4 — the named refusals: same designation / same grade.
    const currentJobTitle = profile?.jobTitle ?? "";
    const currentGrade = profile?.grade ?? "";
    if (data.toJobTitle === currentJobTitle && currentJobTitle !== "") {
      throw new AuthorizationError(
        `${user.name} already holds that designation — a promotion must name a new one.`,
      );
    }
    if (data.toGrade !== undefined && data.toGrade === currentGrade) {
      throw new AuthorizationError(
        `${user.name} is already on that grade — pick a different one (or leave it untouched).`,
      );
    }

    // The optional Phase 1B link — provenance only (spec §3: the salary
    // revision is a separate document; the promotion never acts on it).
    if (data.linkedSalaryAssignmentId) {
      const assignment = await db.salaryStructureAssignment.findUnique({
        where: { id: data.linkedSalaryAssignmentId },
        select: { employeeId: true },
      });
      if (!assignment || assignment.employeeId !== user.id) {
        throw new AuthorizationError(
          "The linked salary revision belongs to a different employee — pick one of theirs, or drop the link.",
        );
      }
    }

    if (
      !promotionChangesAnyFact(
        {
          department: profile?.department ?? "",
          jobTitle: currentJobTitle,
          grade: currentGrade,
          location: profile?.location ?? "",
          managerId: user.managerId ?? null,
        },
        { toJobTitle: data.toJobTitle, toGrade: data.toGrade },
      )
    ) {
      throw new AuthorizationError(
        "Nothing changes — the new designation or grade must differ from the current facts.",
      );
    }

    const created = await db.employeePromotion.create({
      data: {
        employeeId: user.id,
        fromJobTitle: currentJobTitle || null,
        fromGrade: currentGrade || null,
        toJobTitle: data.toJobTitle,
        toGrade: data.toGrade ?? null,
        effectiveDate: dayKeyToDate(data.effectiveDate),
        reason: data.reason ?? null,
        status: "DRAFT",
        linkedSalaryAssignmentId: data.linkedSalaryAssignmentId ?? null,
        createdById: auth.userId,
      },
      select: { id: true },
    });

    await logAudit({
      actor: auth,
      action: "hr.promotion_created",
      entityType: "EMPLOYEE_PROMOTION",
      entityId: created.id,
      entityLabel: user.name,
      detail:
        `${auth.name} drafted a promotion for ${user.name} to ${data.toJobTitle}` +
        `${data.toGrade ? ` (grade ${data.toGrade})` : ""} effective ${data.effectiveDate}` +
        `${data.reason ? ` (reason: ${data.reason})` : ""}.`,
    });
    revalidateEmployeePages(user.id);
    return { id: created.id };
  });
}

// ---------------------------------------------------------------------------
// The lifecycle transitions — submit / approve / cancel (guarded flips).
// ---------------------------------------------------------------------------

export async function submitEmploymentDocument(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employmentDocumentRefSchema, input);
    const todayKey = utcDayKeyOf(new Date());

    const doc =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.findUnique({ where: { id: data.id } })
        : await db.employeePromotion.findUnique({ where: { id: data.id } });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (doc.status !== "DRAFT") {
      throw new AuthorizationError(
        `Only a draft can be submitted — this one is ${statusLabel(doc.status)}.`,
      );
    }

    // Spec §4 — the effective date must be in the future at submission.
    const effectiveDay = utcDayKeyOf(doc.effectiveDate);
    if (!isFutureDay(effectiveDay, todayKey)) {
      throw new AuthorizationError(
        `The effective date must be in the future when submitting — ${effectiveDay} is not after ${todayKey}.`,
      );
    }

    const flipped =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.updateMany({
            where: { id: data.id, status: "DRAFT" },
            data: { status: "PENDING_APPROVAL" },
          })
        : await db.employeePromotion.updateMany({
            where: { id: data.id, status: "DRAFT" },
            data: { status: "PENDING_APPROVAL" },
          });
    if (flipped.count === 0) {
      throw new AuthorizationError(
        "This document is no longer a draft — it was just submitted or cancelled elsewhere. Refresh and try again.",
      );
    }

    const employee = await db.user.findUnique({
      where: { id: doc.employeeId },
      select: { name: true },
    });
    await logAudit({
      actor: auth,
      action: data.kind === "TRANSFER" ? "hr.transfer_submitted" : "hr.promotion_submitted",
      entityType: data.kind === "TRANSFER" ? "EMPLOYEE_TRANSFER" : "EMPLOYEE_PROMOTION",
      entityId: doc.id,
      entityLabel: employee?.name ?? doc.employeeId,
      detail:
        `${auth.name} submitted ${employee?.name ?? "an employee"}'s ${data.kind === "TRANSFER" ? "transfer" : "promotion"} for approval (effective ${effectiveDay}).`,
    });
    revalidateEmployeePages(doc.employeeId);
    return { status: "PENDING_APPROVAL" };
  });
}

export async function approveEmploymentDocument(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employmentDocumentRefSchema, input);

    const doc =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.findUnique({ where: { id: data.id } })
        : await db.employeePromotion.findUnique({ where: { id: data.id } });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (doc.status !== "PENDING_APPROVAL") {
      throw new AuthorizationError(
        `Only a pending document can be approved — this one is ${statusLabel(doc.status)}.`,
      );
    }

    // Spec §4 — four-eyes: the approver is neither the creator nor the
    // subject (the hiring:approve discipline — a different pair of eyes).
    if (doc.createdById === auth.userId) {
      throw new AuthorizationError(
        "You drafted this document — it needs a different pair of eyes to approve it.",
      );
    }
    if (doc.employeeId === auth.userId) {
      throw new AuthorizationError("You cannot approve your own transfer or promotion.");
    }

    const flipped =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.updateMany({
            where: { id: data.id, status: "PENDING_APPROVAL" },
            data: { status: "APPROVED", approvedById: auth.userId, approvedAt: new Date() },
          })
        : await db.employeePromotion.updateMany({
            where: { id: data.id, status: "PENDING_APPROVAL" },
            data: { status: "APPROVED", approvedById: auth.userId, approvedAt: new Date() },
          });
    if (flipped.count === 0) {
      throw new AuthorizationError(
        "This document is no longer pending — it was just approved or cancelled elsewhere. Refresh and try again.",
      );
    }

    const employee = await db.user.findUnique({
      where: { id: doc.employeeId },
      select: { name: true },
    });
    await logAudit({
      actor: auth,
      action: data.kind === "TRANSFER" ? "hr.transfer_approved" : "hr.promotion_approved",
      entityType: data.kind === "TRANSFER" ? "EMPLOYEE_TRANSFER" : "EMPLOYEE_PROMOTION",
      entityId: doc.id,
      entityLabel: employee?.name ?? doc.employeeId,
      detail:
        `${auth.name} approved ${employee?.name ?? "an employee"}'s ${data.kind === "TRANSFER" ? "transfer" : "promotion"} (effective ${utcDayKeyOf(doc.effectiveDate)}).`,
    });
    revalidateEmployeePages(doc.employeeId);
    return { status: "APPROVED" };
  });
}

export async function cancelEmploymentDocument(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(cancelEmploymentDocumentSchema, input);

    const doc =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.findUnique({ where: { id: data.id } })
        : await db.employeePromotion.findUnique({ where: { id: data.id } });
    if (!doc) throw new AuthorizationError("Document not found.");
    if (!CANCELABLE_EMPLOYMENT_DOC_STATUSES.includes(doc.status as EmploymentDocStatus)) {
      throw new AuthorizationError(
        doc.status === "EFFECTIVE"
          ? "This document is already effective — the facts have been applied and cannot be unwound by a cancel."
          : "This document is already cancelled.",
      );
    }

    // Spec §2: the creator, before EFFECTIVE. ADMIN rides as the safety
    // valve (the RBAC ceiling of this whole feature) so an orphaned
    // APPROVED document whose creator is gone still has a cancel path —
    // otherwise it would auto-effect on its date with no way back.
    if (doc.createdById !== auth.userId && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      throw new AuthorizationError(
        "Only the document's creator (or an admin) can cancel it.",
      );
    }

    const flipped =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.updateMany({
            where: {
              id: data.id,
              status: { in: [...CANCELABLE_EMPLOYMENT_DOC_STATUSES] },
            },
            data: { status: "CANCELLED", cancelledById: auth.userId, cancelledAt: new Date() },
          })
        : await db.employeePromotion.updateMany({
            where: {
              id: data.id,
              status: { in: [...CANCELABLE_EMPLOYMENT_DOC_STATUSES] },
            },
            data: { status: "CANCELLED", cancelledById: auth.userId, cancelledAt: new Date() },
          });
    if (flipped.count === 0) {
      throw new AuthorizationError(
        "This document just changed state elsewhere — refresh and try again.",
      );
    }

    const employee = await db.user.findUnique({
      where: { id: doc.employeeId },
      select: { name: true },
    });
    await logAudit({
      actor: auth,
      action: data.kind === "TRANSFER" ? "hr.transfer_cancelled" : "hr.promotion_cancelled",
      entityType: data.kind === "TRANSFER" ? "EMPLOYEE_TRANSFER" : "EMPLOYEE_PROMOTION",
      entityId: doc.id,
      entityLabel: employee?.name ?? doc.employeeId,
      detail:
        `${auth.name} cancelled ${employee?.name ?? "an employee"}'s ${data.kind === "TRANSFER" ? "transfer" : "promotion"}` +
        `${data.reason ? ` (reason: ${data.reason})` : ""}.`,
    });
    revalidateEmployeePages(doc.employeeId);
    return { status: "CANCELLED" };
  });
}

// ---------------------------------------------------------------------------
// The manual EFFECTIVE trigger — delegates to the ONE effect core the
// daily sweep also rides (lib/hr/employment-doc-effect.ts).
// ---------------------------------------------------------------------------

export async function makeEmploymentDocumentEffective(
  input: unknown,
): Promise<ActionResult<{ status: string; applied: number }>> {
  return toResult(async () => {
    const auth = (await requirePermission("hr:admin")) as AuthCtx;
    const data = parseOrThrow(employmentDocumentRefSchema, input);

    // The employee id for the revalidation targets (the effect core re-reads
    // the document itself — this read is display-side only).
    const docRef =
      data.kind === "TRANSFER"
        ? await db.employeeTransfer.findUnique({
            where: { id: data.id },
            select: { employeeId: true },
          })
        : await db.employeePromotion.findUnique({
            where: { id: data.id },
            select: { employeeId: true },
          });
    if (!docRef) throw new AuthorizationError("Document not found.");

    const result = await effectEmploymentDocument({
      kind: data.kind,
      id: data.id,
      actor: { userId: auth.userId, name: auth.name, role: auth.role },
      requireDateReached: true,
    });
    revalidateEmployeePages(docRef.employeeId);
    return { status: "EFFECTIVE", applied: result.applied };
  });
}

// ---------------------------------------------------------------------------
// Readers (hr:view — the getEmploymentHistory convention).
// ---------------------------------------------------------------------------

export async function getEmployeeTransfers(
  employeeId: string,
): Promise<ActionResult<EmployeeTransferT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    await loadEmployee(employeeId);

    const rows = await db.employeeTransfer.findMany({
      where: { employeeId },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    const names = await nameMapOf([
      ...rows.map((r) => r.createdById),
      ...rows.map((r) => r.approvedById),
      ...rows.map((r) => r.cancelledById),
      ...rows.map((r) => r.fromManagerId),
      ...rows.map((r) => r.toManagerId),
    ]);
    return rows.map((r): EmployeeTransferT => ({
      id: r.id,
      employeeId: r.employeeId,
      fromDepartment: r.fromDepartment,
      toDepartment: r.toDepartment,
      fromJobTitle: r.fromJobTitle,
      toJobTitle: r.toJobTitle,
      fromManagerId: r.fromManagerId,
      toManagerId: r.toManagerId,
      fromLocation: r.fromLocation,
      toLocation: r.toLocation,
      effectiveDate: utcDayKeyOf(r.effectiveDate),
      reason: r.reason,
      status: r.status,
      approvedById: r.approvedById,
      approvedByName: r.approvedById ? names.get(r.approvedById) ?? null : null,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      cancelledById: r.cancelledById,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      createdById: r.createdById,
      createdByName: names.get(r.createdById) ?? r.createdById,
      fromManagerName: r.fromManagerId ? names.get(r.fromManagerId) ?? null : null,
      toManagerName: r.toManagerId ? names.get(r.toManagerId) ?? null : null,
    }));
  });
}

export async function getEmployeePromotions(
  employeeId: string,
): Promise<ActionResult<EmployeePromotionT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    await loadEmployee(employeeId);

    const rows = await db.employeePromotion.findMany({
      where: { employeeId },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    const names = await nameMapOf([
      ...rows.map((r) => r.createdById),
      ...rows.map((r) => r.approvedById),
      ...rows.map((r) => r.cancelledById),
    ]);
    return rows.map((r): EmployeePromotionT => ({
      id: r.id,
      employeeId: r.employeeId,
      fromJobTitle: r.fromJobTitle,
      toJobTitle: r.toJobTitle,
      fromGrade: r.fromGrade,
      toGrade: r.toGrade,
      effectiveDate: utcDayKeyOf(r.effectiveDate),
      reason: r.reason,
      status: r.status,
      approvedById: r.approvedById,
      approvedByName: r.approvedById ? names.get(r.approvedById) ?? null : null,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      cancelledById: r.cancelledById,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      linkedSalaryAssignmentId: r.linkedSalaryAssignmentId,
      createdAt: r.createdAt.toISOString(),
      createdById: r.createdById,
      createdByName: names.get(r.createdById) ?? r.createdById,
    }));
  });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function statusLabel(status: string): string {
  return (
    EMPLOYMENT_DOC_STATUS_LABELS[status as EmploymentDocStatus]?.toLowerCase() ?? status
  );
}

// ---------------------------------------------------------------------------
// The create-form context — the live facts + the manager options the
// transfer/promotion forms prefill from (hr:view: the reader convention;
// the writes stay hr:admin).
// ---------------------------------------------------------------------------

export async function getEmploymentDocumentContext(
  employeeId: string,
): Promise<
  ActionResult<{
    employee: { id: string; name: string; email: string };
    current: {
      department: string;
      jobTitle: string;
      grade: string;
      location: string;
      managerId: string | null;
      managerName: string | null;
    };
    members: Array<{ id: string; name: string }>;
  }>
> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const { user, profile } = await loadEmployee(employeeId);

    let managerName: string | null = null;
    if (user.managerId) {
      const mgr = await db.user.findUnique({
        where: { id: user.managerId },
        select: { name: true, deletedAt: true },
      });
      managerName = mgr && !mgr.deletedAt ? mgr.name : null;
    }
    const members = await db.user.findMany({
      where: { deletedAt: null, id: { not: user.id } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    });

    return {
      employee: { id: user.id, name: user.name, email: user.email },
      current: {
        department: profile?.department ?? "",
        jobTitle: profile?.jobTitle ?? "",
        grade: profile?.grade ?? "",
        location: profile?.location ?? "",
        managerId: user.managerId ?? null,
        managerName,
      },
      members,
    };
  });
}

/** The employment-documents index list — every active employee with the
 * facts the transfer/promotion forms start from (hr:view). */
export async function getEmploymentDocumentEmployees(): Promise<
  ActionResult<
    Array<{
      id: string;
      name: string;
      email: string;
      jobTitle: string;
      department: string;
      grade: string;
    }>
  >
> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const users = await db.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
      take: 500,
    });
    // EmployeeProfile links by plain userId (no Prisma relation — the HR
    // module's convention), so the facts ride a second keyed query.
    const profiles = await db.employeeProfile.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { userId: true, jobTitle: true, department: true, grade: true },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      jobTitle: profileByUser.get(u.id)?.jobTitle ?? "",
      department: profileByUser.get(u.id)?.department ?? "",
      grade: profileByUser.get(u.id)?.grade ?? "",
    }));
  });
}
