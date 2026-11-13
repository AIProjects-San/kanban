"use server";

// ---------------------------------------------------------------------------
// P39 (EM-16's advances half, EX-03 lite) — salary advances
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P39).
//
// Issue → installment recovery through the PayAdjustment adapter → the
// FnF receivable line. The recovery rides the P1 adapter as DEDUCTION-side
// RECURRING rows (sourceType SALARY_ADVANCE, sourceId the advance's id):
// each consuming run eats one installment's deduction, and the run that
// consumes the FINAL row flips the advance RECOVERED (the lock
// transaction's PENDING→CONSUMED walk — provenance-linked, no new
// scheduler). Loans proper stay the later un-decline epic.
//
// RBAC:
//   issue / reads — payroll:manage (ADMIN + HR; advances are money)
//   the recovery  — the adapter rows consume inside the run lock like
//                   every other adjustment (no new permission)
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { issueSalaryAdvanceSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type { SalaryAdvanceT } from "@/lib/types";
import { advanceSummary, installmentPlan } from "@/lib/payroll/salary-advances";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All advances (payroll:manage), newest first, with the live consumed
 *  state derived from the adapter rows (provenance-linked through
 *  sourceId — the rows are the source of truth). */
export async function getSalaryAdvances(): Promise<ActionResult<SalaryAdvanceT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.salaryAdvance.findMany({
      orderBy: { issuedAt: "desc" },
      take: 200,
    });
    if (rows.length === 0) return [];
    const adjustments = await db.payAdjustment.findMany({
      where: { sourceType: "SALARY_ADVANCE", sourceId: { in: rows.map((r) => r.id) } },
      select: { sourceId: true, status: true, amount: true },
    });
    const consumedByAdvance = new Map<string, { count: number; total: number }>();
    for (const a of adjustments) {
      if (a.status !== "CONSUMED") continue;
      const agg = consumedByAdvance.get(a.sourceId) ?? { count: 0, total: 0 };
      agg.count += 1;
      agg.total += a.amount;
      consumedByAdvance.set(a.sourceId, agg);
    }
    const names = await namesFor([
      ...rows.map((r) => r.userId),
      ...rows.map((r) => r.issuedById).filter(Boolean),
    ]);
    return rows.map((r) => serializeAdvance(r, names, consumedByAdvance.get(r.id) ?? { count: 0, total: 0 }));
  });
}

function serializeAdvance(
  row: {
    id: string; userId: string; amount: number; status: string; installments: number;
    startPeriod: string; reason: string; issuedById: string; issuedAt: Date; recoveredAt: Date | null;
  },
  names: Map<string, string>,
  consumed: { count: number; total: number },
): SalaryAdvanceT {
  const summary = advanceSummary({
    amount: row.amount,
    status: row.status,
    installments: row.installments,
    consumedCount: consumed.count,
    consumedTotal: consumed.total,
  });
  return {
    id: row.id,
    userId: row.userId,
    userName: names.get(row.userId) ?? "(former user)",
    amount: row.amount,
    status: row.status === "RECOVERED" ? "RECOVERED" : "OPEN",
    installments: row.installments,
    startPeriod: row.startPeriod,
    reason: row.reason,
    issuedBy: row.issuedById ? names.get(row.issuedById) ?? null : null,
    issuedAt: row.issuedAt.toISOString(),
    recoveredAt: row.recoveredAt ? row.recoveredAt.toISOString() : null,
    consumedCount: consumed.count,
    consumedTotal: consumed.total,
    outstanding: summary.outstanding,
    summary: summary.summary,
  };
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

// ---------------------------------------------------------------------------
// Issue (payroll:manage)
// ---------------------------------------------------------------------------

/** Issue one salary advance: the SalaryAdvance row + its N equal
 *  DEDUCTION-side RECURRING adapter rows in ONE transaction (the rounding
 *  remainder rides the LAST installment so the plan sums exactly). */
export async function issueSalaryAdvance(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(issueSalaryAdvanceSchema, input);

    const employee = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");

    const plan = installmentPlan(data.amount, data.installments);
    if (plan.length === 0 || plan.some((p) => !(p > 0))) {
      throw new AuthorizationError("The installment plan could not be built from that amount.");
    }

    const advanceId = await db.$transaction(async (tx) => {
      const advance = await tx.salaryAdvance.create({
        data: {
          userId: employee.id,
          amount: data.amount,
          status: "OPEN",
          installments: plan.length,
          startPeriod: data.startPeriod,
          reason: data.reason,
          issuedById: auth.userId,
          adjustmentCount: plan.length,
        },
      });
      // The recovery rows: DEDUCTION-side RECURRING through the P1
      // adapter — one per installment, equal periods from startPeriod.
      // (createMany with the mapped plan — the adapter's own kernel
      // consumes them inside the run lock like every other adjustment.)
      const [y, m] = data.startPeriod.split("-").map(Number);
      await tx.payAdjustment.createMany({
        data: plan.map((amount, i) => {
          const mi = m - 1 + i;
          const period = `${y + Math.floor(mi / 12)}-${String((mi % 12) + 1).padStart(2, "0")}`;
          return {
            userId: employee.id,
            sourceType: "SALARY_ADVANCE",
            sourceId: advance.id,
            label: `Salary advance recovery — installment ${i + 1} of ${plan.length}`,
            side: "DEDUCTION",
            recurrence: "ONE_SHOT",
            calcMode: "FIXED",
            amount,
            period,
            status: "PENDING",
            note: `Advance issued ${new Date().toISOString().slice(0, 10)} (${data.reason || "no reason recorded"}).`,
            createdById: auth.userId,
          };
        }),
      });
      return advance.id;
    });

    await logAudit({
      actor: auth,
      action: "payroll.advance_issued",
      entityType: "SALARY_ADVANCE",
      entityId: advanceId,
      entityLabel: `${employee.name} — $${data.amount.toFixed(2)}`,
      detail: `${auth.name} issued a $${data.amount.toFixed(2)} salary advance to ${employee.name} (${plan.length} installment${plan.length === 1 ? "" : "s"} from ${data.startPeriod}).`,
    });
    revalidatePath("/");
    return { id: advanceId };
  });
}
