"use server";

// ---------------------------------------------------------------------------
// Phase 1B (G8) — effective-dated salary assignment actions: the salary
// history timeline and the revision writer.
//
// RBAC: payroll:manage (ADMIN + HR) — same ceiling as every salary path.
//
// The revision (createSalaryRevision) is ONE transaction that:
//   1. validates the new fromDate against the current open assignment
//      (strictly after its fromDate; past dates need the explicit backdate
//      flag) and refuses timeline overlaps;
//   2. when the ANNUAL base changed, clones the referenced structure with
//      its basic anchor re-priced (a pay change is a NEW structure row —
//      structures are never edited in place once assigned, so paid history
//      stays byte-identical) and retires the old row only if it was the
//      employee's active one (the one-active invariant);
//   3. closes the current assignment (toDate = new fromDate) and opens the
//      new one (fromDate = new fromDate, toDate = null) atomically.
//
// URL note: the (admin) route group is stripped — the page lives at
// /employees/[id]/salary-history, which the revalidatePath calls name.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { parseOrThrow, createSalaryRevisionSchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { SalaryAssignmentT } from "@/lib/types";
import { basicKeyOf, parseComponents } from "@/lib/offer-math";
import { resolveAssignmentAt } from "@/lib/payroll/resolve-assignment";
import { detectArrears } from "@/lib/payroll/detect-arrears";

/** Serialize one assignment row for the UI (ISO dates, number facts). */
function serializeAssignment(
  a: {
    id: string; employeeId: string; structureId: string;
    fromDate: Date; toDate: Date | null;
    base: { toNumber(): number }; variable: { toNumber(): number };
    reason: string | null; approvedById: string | null; approvedAt: Date | null;
    createdAt: Date; createdById: string;
    structure: { isActive: boolean };
  },
  nameById: Map<string, string>,
): SalaryAssignmentT {
  return {
    id: a.id,
    employeeId: a.employeeId,
    structureId: a.structureId,
    fromDate: a.fromDate.toISOString(),
    toDate: a.toDate ? a.toDate.toISOString() : null,
    base: a.base.toNumber(),
    variable: a.variable.toNumber(),
    reason: a.reason,
    approvedById: a.approvedById,
    approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    createdById: a.createdById,
    createdByName: nameById.get(a.createdById) ?? a.createdById,
    structureActive: a.structure.isActive,
  };
}

/** The employee's assignment timeline, newest first, with the employee
 *  header facts the page shows. */
export async function getSalaryHistory(
  employeeId: string,
): Promise<ActionResult<{ employee: { id: string; name: string; email: string; jobTitle: string }; assignments: SalaryAssignmentT[] }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const user = await db.user.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, email: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new AuthorizationError("Employee not found.");
    const profile = await db.employeeProfile.findUnique({
      where: { userId: employeeId },
      select: { jobTitle: true },
    });
    const rows = await db.salaryStructureAssignment.findMany({
      where: { employeeId },
      include: { structure: { select: { isActive: true } } },
      orderBy: { fromDate: "desc" },
    });
    const creatorIds = [...new Set(rows.map((r) => r.createdById))];
    const creators = creatorIds.length > 0
      ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(creators.map((c) => [c.id, c.name]));
    return {
      employee: { id: user.id, name: user.name, email: user.email, jobTitle: profile?.jobTitle ?? "" },
      assignments: rows.map((r) => serializeAssignment(r, nameById)),
    };
  });
}

/** Close the current open assignment at fromDate and open the revision —
 *  one transaction, with the structure clone when the base changed. */
export async function createSalaryRevision(
  input: unknown,
): Promise<ActionResult<{ id: string; arrears: Array<{ periodStart: string; periodEnd: string; delta: number }> }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createSalaryRevisionSchema, input);

    const newFrom = new Date(`${data.fromDate}T00:00:00.000Z`);

    return db.$transaction(async (tx) => {
      const current = await tx.salaryStructureAssignment.findFirst({
        where: { employeeId: data.employeeId, toDate: null },
        orderBy: { fromDate: "desc" },
        include: { structure: true },
      });
      if (!current) {
        throw new AuthorizationError(
          "This employee has no open salary assignment to revise — create their salary structure and run the backfill first.",
        );
      }

      // The new window must start strictly after the current one — a same-day
      // or earlier fromDate would overlap (or duplicate) the timeline.
      if (newFrom.getTime() <= current.fromDate.getTime()) {
        throw new AuthorizationError(
          `The new effective date must be after the current assignment's start (${current.fromDate.toISOString().slice(0, 10)}).`,
        );
      }

      // Past dates need the explicit backdate flag (the revision re-prices
      // every FUTURE run window, not locked history — but HR should say so).
      const todayUtc = new Date();
      const todayStart = new Date(
        Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate()),
      );
      if (!data.backdate && newFrom.getTime() < todayStart.getTime()) {
        throw new AuthorizationError(
          "That effective date is in the past — tick “backdate” to confirm a retroactive revision.",
        );
      }

      const newBase = data.base;
      const newVariable = data.variable ?? current.variable.toNumber();
      const payChanged =
        newBase !== current.base.toNumber() || newVariable !== current.variable.toNumber();

      // A pay change is a NEW structure row (cloned, basic anchor re-priced):
      // the old row keeps pricing every window its assignment covers.
      let structureId = current.structureId;
      if (payChanged) {
        const components = parseComponents(current.structure.components);
        const basicKey = basicKeyOf(components);
        if (newBase !== current.base.toNumber() && !basicKey) {
          throw new AuthorizationError(
            "This structure has no fixed basic component to re-price — edit the structure directly instead.",
          );
        }
        const nextComponents = components.map((c) =>
          basicKey && c.key === basicKey ? { ...c, amount: newBase } : c,
        );
        // Retire the old row only when it is the employee's ACTIVE one (the
        // one-active-per-cadence invariant future runs read through the
        // legacy path); the clone takes over the active slot.
        if (current.structure.isActive) {
          await tx.salaryStructure.update({
            where: { id: current.structureId },
            data: { isActive: false },
          });
        }
        const clone = await tx.salaryStructure.create({
          data: {
            userId: data.employeeId,
            components: JSON.stringify(nextComponents),
            notes: `${data.reason.toLowerCase()} from ${data.fromDate} — cloned from structure ${current.structureId.slice(-6)}`,
            maxBenefits: current.structure.maxBenefits,
            frequency: current.structure.frequency,
            isDefault: false,
            openingYtd: current.structure.openingYtd
              ? (current.structure.openingYtd as object)
              : undefined,
            effectiveFrom: newFrom,
            isActive: current.structure.isActive,
            createdById: auth.userId,
          },
        });
        structureId = clone.id;
      }

      // Close the current open assignment and open the revision — both, or
      // neither (the transaction). The audit log + arrears detection run
      // AFTER the commit: logAudit writes on the GLOBAL client, and calling
      // it inside this interactive transaction would open a second
      // SQLite connection that blocks on the transaction's own write lock
      // until the timeout expires (the CI-repair lesson lockPayrollRun
      // documents — "Transaction already closed").
      await tx.salaryStructureAssignment.update({
        where: { id: current.id },
        data: { toDate: newFrom },
      });
      const created = await tx.salaryStructureAssignment.create({
        data: {
          employeeId: data.employeeId,
          structureId,
          fromDate: newFrom,
          toDate: null,
          base: newBase,
          variable: newVariable,
          reason: data.reason,
          approvedById: auth.userId,
          approvedAt: new Date(),
          createdById: auth.userId,
        },
      });
      return {
        created,
        previousFromDate: current.fromDate,
        payChanged,
        newBase,
        newVariable,
      };
    }, { timeout: 30_000 })
      .then(async ({ created, previousFromDate, payChanged, newBase, newVariable }) => {
        await logAudit({
          actor: auth,
          action: "payroll.salary_revision",
          entityType: "SALARY_ASSIGNMENT",
          entityId: created.id,
          entityLabel: `${data.employeeId} from ${data.fromDate}`,
          detail: `${auth.name} created a ${data.reason.toLowerCase()} effective ${data.fromDate} — base $${newBase.toLocaleString("en-NZ")}${newVariable > 0 ? ` + variable $${newVariable.toLocaleString("en-NZ")}` : ""} (annual); the previous assignment (${previousFromDate.toISOString().slice(0, 10)} → ${data.fromDate}) was closed${payChanged ? " and the structure was re-priced through a cloned row" : ""}${data.backdate === true ? " (explicit backdate)" : ""}.`,
        });
        revalidatePath(`/employees/${data.employeeId}/salary-history`);
        revalidatePath("/employees");

        // 1B.6 — detect (never post) the arrears the backdated revision
        // implies over already-locked windows (read-only, post-commit).
        const arrears = await detectArrears(data.employeeId, created.id);
        return {
          id: created.id,
          arrears: arrears.map((a) => ({
            periodStart: a.periodStart.toISOString(),
            periodEnd: a.periodEnd.toISOString(),
            delta: a.delta,
          })),
        };
      })
      .catch((e: unknown) => {
        if (isUniqueConstraintError(e)) {
          throw new AuthorizationError(
            "An assignment already begins on that date for this employee.",
          );
        }
        throw e;
      });
  });
}

/** Exposed for the UI's revision modal preview: the assignment in force at
 *  an arbitrary date (the modal shows what a backdate would re-price). */
export async function previewAssignmentAt(
  employeeId: string,
  date: string,
): Promise<ActionResult<SalaryAssignmentT | null>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const at = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(at.getTime())) throw new AuthorizationError("Invalid date.");
    const row = await resolveAssignmentAt(db, employeeId, at);
    if (!row) return null;
    const creator = row.createdById
      ? await db.user.findUnique({ where: { id: row.createdById }, select: { id: true, name: true } })
      : null;
    return serializeAssignment(
      row as unknown as Parameters<typeof serializeAssignment>[0],
      new Map(creator ? [[creator.id, creator.name]] : []),
    );
  });
}
