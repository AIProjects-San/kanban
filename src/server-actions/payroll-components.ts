"use server";

// ---------------------------------------------------------------------------
// F1.5 — salary component catalog server actions
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1; benchmark: frappe/hrms
// Salary Component master).
//
// RBAC: everything here is `payroll:manage` (ADMIN + HR) — the component
// vocabulary defines what the workspace pays, so it is as sensitive as the
// salary numbers themselves. Members never see the catalog; they only see
// the EFFECT of picked components on their own payslips (getMyPayslips).
//
// Semantics: the catalog is master data for the structure editor's picker,
// never a runtime dependency. Structures snapshot their own component lines
// (same discipline as offers vs offer templates), so editing or retiring a
// row changes only what the picker offers next time. One row per code
// (unique) — a duplicate code maps to a real message (QA-18 convention,
// same as holiday dates and leave type codes).
//
// F-R1 note: catalog writes are single-row upserts (nothing to orphan), so
// they do not need the transaction the structure actions gained.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { SalaryComponentT } from "@/lib/types";
import type { ActionResult } from "@/lib/action-result";
import {
  saveSalaryComponentSchema,
  deleteSalaryComponentSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";

/** P23 — the human-readable amount suggestion by mode (audit lines + the
 * catalog list agree on one phrasing). */
function describeAmount(mode: string, defaultAmount: number): string {
  if (mode === "PERCENT_OF_BASIC") return `${defaultAmount}% of basic`;
  if (mode === "PERCENT_OF_GROSS") return `${defaultAmount}% of gross`;
  if (mode === "PERCENT_OF_NET") return `${defaultAmount}% of net (at payroll time)`;
  return `$${defaultAmount}/yr suggestion`;
}

function serialize(r: {
  id: string;
  code: string;
  label: string;
  kind: string;
  mode: string;
  defaultAmount: number;
  dependsOnPaymentDays: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  isActive: boolean;
  sortOrder: number;
  taxApplicable: boolean;
  statutoryCategory: string;
  wageBaseRef: string;
  isSystemGenerated: boolean;
  createdAt: Date;
}): SalaryComponentT {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    kind: r.kind as SalaryComponentT["kind"],
    mode: r.mode as SalaryComponentT["mode"],
    defaultAmount: r.defaultAmount,
    // S6 — the payment-days knob rides the serialization (UI checkbox).
    dependsOnPaymentDays: r.dependsOnPaymentDays,
    // P16 — the catalog validity window (null = unbounded).
    effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString().slice(0, 10) : null,
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    // Phase 3 (Task 3.3) — the statutory tax mapping rides along for
    // display; the super-admin mapping editor owns the values.
    taxApplicable: r.taxApplicable,
    statutoryCategory: r.statutoryCategory as SalaryComponentT["statutoryCategory"],
    wageBaseRef: r.wageBaseRef as SalaryComponentT["wageBaseRef"],
    isSystemGenerated: r.isSystemGenerated,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The whole catalog (active + retired — the picker offers active rows and
 * the manager list shows both, same as leave types). Ordered by sortOrder,
 * then code, so curated rows keep their place. */
export async function getSalaryComponents(): Promise<ActionResult<SalaryComponentT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.salaryComponent.findMany({
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });
    return rows.map(serialize);
  });
}

/** Create or update one catalog row. `id` present → update (the code may
 * move); absent → create. A code already taken by ANOTHER row rejects with a
 * message that names the conflicting code. */
export async function saveSalaryComponent(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(saveSalaryComponentSchema, input);

    const payload = {
      code: data.code,
      label: data.label,
      kind: data.kind,
      mode: data.mode,
      defaultAmount: data.defaultAmount,
      dependsOnPaymentDays: data.dependsOnPaymentDays,
      // P16 — the optional validity window (null = unbounded; the schema
      // already refuses a window whose start follows its end).
      effectiveFrom: data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00Z`) : null,
      effectiveTo: data.effectiveTo ? new Date(`${data.effectiveTo}T00:00:00Z`) : null,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    };

    if (data.id) {
      const existing = await db.salaryComponent.findUnique({ where: { id: data.id } });
      if (!existing) throw new AuthorizationError("Component not found.");
      try {
        const updated = await db.salaryComponent.update({ where: { id: data.id }, data: payload });
        await logAudit({
          actor: auth,
          action: "payroll.component_updated",
          entityType: "SALARY_COMPONENT",
          entityId: updated.id,
          entityLabel: `${updated.code} (${updated.label})`,
          detail: `${auth.name} updated the salary component ${updated.code} — ${updated.label} (${updated.kind}, ${describeAmount(updated.mode, updated.defaultAmount)}, ${updated.dependsOnPaymentDays ? "payment-day scaled" : "window-exempt"}${updated.effectiveFrom || updated.effectiveTo ? `, effective ${updated.effectiveFrom ? updated.effectiveFrom.toISOString().slice(0, 10) : "—"} → ${updated.effectiveTo ? updated.effectiveTo.toISOString().slice(0, 10) : "—"}` : ""}, ${updated.isActive ? "active" : "retired"}).`,
        });
        revalidatePath("/");
        return { id: updated.id };
      } catch (e) {
        if (isUniqueConstraintError(e)) {
          throw new AuthorizationError(
            `Code "${data.code}" is already in the catalog — one component per code. Edit the existing row instead.`,
          );
        }
        throw e;
      }
    }

    try {
      const created = await db.salaryComponent.create({ data: payload });
      await logAudit({
        actor: auth,
        action: "payroll.component_created",
        entityType: "SALARY_COMPONENT",
        entityId: created.id,
        entityLabel: `${created.code} (${created.label})`,
        detail: `${auth.name} added the salary component ${created.code} — ${created.label} (${created.kind}, ${describeAmount(created.mode, created.defaultAmount)}${created.dependsOnPaymentDays ? "" : ", window-exempt"}${created.effectiveFrom || created.effectiveTo ? `, effective ${created.effectiveFrom ? created.effectiveFrom.toISOString().slice(0, 10) : "—"} → ${created.effectiveTo ? created.effectiveTo.toISOString().slice(0, 10) : "—"}` : ""}).`,
      });
      revalidatePath("/");
      return { id: created.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `Code "${data.code}" is already in the catalog — one component per code. Edit the existing row instead.`,
        );
      }
      throw e;
    }
  });
}

/** Remove one catalog row. Structures keep their snapshot copies, so this
 * corrupts nothing — but the code disappears from the picker (and would be
 * re-auto-registered by the next createStructureFromOffer that sees it).
 * Retiring (isActive=false) is the reversible alternative; delete is for
 * typos. */
export async function deleteSalaryComponent(input: {
  id: string;
}): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(deleteSalaryComponentSchema, input);

    const existing = await db.salaryComponent.findUnique({ where: { id: data.id } });
    if (!existing) throw new AuthorizationError("Component not found.");

    await db.salaryComponent.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "payroll.component_deleted",
      entityType: "SALARY_COMPONENT",
      entityId: existing.id,
      entityLabel: `${existing.code} (${existing.label})`,
      detail: `${auth.name} removed the salary component ${existing.code} — ${existing.label} from the catalog (existing structures keep their copies).`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}
