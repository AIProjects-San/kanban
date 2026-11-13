"use server";

// ---------------------------------------------------------------------------
// P1 (PR-12/PR-B10, F2.3) — the PayAdjustment universal adapter panel (split
// from payroll.ts): manual rows, the list, and the explicit apply-to-open-run
// pass. Feature-owned sources (ENCASHMENT, ARREARS, …) are written by their
// own actions with their own provenance, never through the manual path.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { PayAdjustmentT } from "@/lib/types";
import { createPayAdjustmentSchema, lockPayrollRunSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parsePayslipLines, withRoundingLine, payslipTotals } from "@/lib/payroll/payroll-math";
import { applyAdjustments, isDueInPeriod, validateAdjustmentInput, type PayAdjustmentRow } from "@/lib/payroll/pay-adjustment";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";

// ---------------------------------------------------------------------------
// P1 (PR-12/PR-B10, F2.3) — the PayAdjustment universal adapter
// ---------------------------------------------------------------------------

/** Serialize one adapter row for the payroll view's Adjustments panel. */
function serializeAdjustment(
  row: PayAdjustmentRow & { createdAt: Date },
  userName: string,
  consumedRunPeriod: string,
): PayAdjustmentT {
  return {
    id: row.id,
    userId: row.userId,
    userName,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    componentCode: row.componentCode,
    label: row.label || row.componentCode,
    side: (row.side === "DEDUCTION" ? "DEDUCTION" : "EARNING") as "EARNING" | "DEDUCTION",
    recurrence: (["ONE_SHOT", "RECURRING", "OVERWRITE"].includes(row.recurrence)
      ? row.recurrence
      : "ONE_SHOT") as "ONE_SHOT" | "RECURRING" | "OVERWRITE",
    calcMode: (["FIXED", "PERCENT_OF_GROSS", "PERCENT_OF_NET"].includes(row.calcMode)
      ? row.calcMode
      : "FIXED") as "FIXED" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET",
    percent: row.percent ?? null,
    amount: row.amount,
    period: row.period,
    endPeriod: row.endPeriod ?? null,
    lastConsumedPeriod: row.lastConsumedPeriod,
    status: (["PENDING", "CONSUMED", "SKIPPED"].includes(row.status) ? row.status : "PENDING") as
      | "PENDING"
      | "CONSUMED"
      | "SKIPPED",
    skipReason: row.skipReason,
    note: row.note,
    consumedRunPeriod,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The manual adjustment writer (payroll:manage). Shape validation in the
 * zod schema; the semantic matrix (percent-vs-side, endPeriod order,
 * label-or-code) in the pure kernel's validateAdjustmentInput — one rule
 * shared with the UI. MANUAL/INCENTIVE sources only: feature-owned sources
 * (ENCASHMENT, ARREARS, …) are written by their own actions with their own
 * provenance, never through this hand-made path. */
export async function createPayAdjustment(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createPayAdjustmentSchema, input);
    const semanticError = validateAdjustmentInput({
      side: data.side,
      recurrence: data.recurrence,
      calcMode: data.calcMode,
      percent: data.percent ?? null,
      amount: data.amount,
      period: data.period,
      endPeriod: data.endPeriod ?? null,
      label: data.label,
      componentCode: data.componentCode,
    });
    if (semanticError) throw new AuthorizationError(semanticError);
    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
    if (!user) throw new AuthorizationError("Employee not found.");
    // A locked period never takes new adjustments: paid runs are immutable
    // and no new run will ever consume the row (dead input by construction).
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.period },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError("That period is already locked — paid runs never take new adjustments.");
    }
    const row = await db.payAdjustment.create({
      data: {
        userId: data.userId,
        sourceType: data.sourceType,
        sourceId: "",
        componentCode: data.componentCode,
        label: data.label,
        side: data.side,
        recurrence: data.recurrence,
        calcMode: data.calcMode,
        percent: data.percent ?? null,
        amount: data.amount,
        period: data.period,
        endPeriod: data.endPeriod ?? null,
        note: data.note,
        createdById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "payroll.adjustment_created",
      entityType: "PAY_ADJUSTMENT",
      entityId: row.id,
      entityLabel: `${user.name} — ${data.label || data.componentCode}`,
      detail: `${auth.name} added a ${data.recurrence.toLowerCase()} ${data.side.toLowerCase()} adjustment for ${user.name}: ${
        data.calcMode === "FIXED"
          ? `$${data.amount.toLocaleString("en-NZ")}`
          : `${data.percent}% of ${data.calcMode === "PERCENT_OF_GROSS" ? "gross" : "net"}`
      }, first period ${data.period}${data.endPeriod ? ` through ${data.endPeriod}` : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Every adapter row (newest first, capped) with names + the consuming
 * run's period — the Adjustments panel's data. payroll:manage. */
export async function listPayAdjustments(): Promise<ActionResult<PayAdjustmentT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.payAdjustment.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    if (rows.length === 0) return [];
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const runIds = [...new Set(rows.map((r) => r.consumedRunId).filter((id) => id !== ""))];
    const runs = runIds.length > 0
      ? await db.payrollRun.findMany({ where: { id: { in: runIds } }, select: { id: true, period: true } })
      : [];
    const periodByRunId = new Map(runs.map((r) => [r.id, r.period]));
    return rows.map((row) =>
      serializeAdjustment(
        row,
        nameById.get(row.userId) ?? "Unknown",
        periodByRunId.get(row.consumedRunId) ?? "",
      ),
    );
  });
}

/** Explicitly apply the period's PENDING adjustments to an OPEN run's
 * existing payslips (created after the run was). The rows resolve through
 * the same two-pass kernel onto the STORED lines (manual edits preserved;
 * the stale rounding line is re-derived after), each touched slip's
 * optimistic-lock version increments, and the row updates commit in one
 * transaction with the line writes — no silent re-derivation, ever. */
export async function applyPayAdjustmentsToRun(
  input: unknown,
): Promise<ActionResult<{ applied: number; skipped: number; slipsTouched: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(lockPayrollRunSchema, input);
    const run = await db.payrollRun.findUnique({ where: { id: data.runId } });
    if (!run) throw new AuthorizationError("Payroll run not found.");
    if (run.status !== "OPEN") throw new AuthorizationError("The run is locked — payslips are immutable once paid.");

    const pendingAdjustments = await db.payAdjustment.findMany({
      // P10 — no period-string pre-filter: the window-aware predicate
      // decides due-ness (isDueInPeriod below).
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    const dueRows = pendingAdjustments.filter((row) => isDueInPeriod(row, run.period));
    if (dueRows.length === 0) return { applied: 0, skipped: 0, slipsTouched: 0 };

    const dueByUser = new Map<string, PayAdjustmentRow[]>();
    for (const row of dueRows) {
      const list = dueByUser.get(row.userId);
      if (list) list.push(row);
      else dueByUser.set(row.userId, [row]);
    }
    const slips = await db.payslip.findMany({ where: { runId: run.id } });
    const slipUserIds = new Set(slips.map((s) => s.userId));
    const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;

    type ConsumedEntry = { row: PayAdjustmentRow; final: boolean };
    const consumedEntries: ConsumedEntry[] = [];
    const skipById = new Map<string, string>();
    // Due rows whose employee has no slip: ONE_SHOT/OVERWRITE periods never
    // come back — SKIPPED with reason; RECURRING stays PENDING for the future.
    const noSlipSkips = dueRows.filter(
      (row) => !slipUserIds.has(row.userId) && row.recurrence !== "RECURRING",
    );

    let slipsTouched = 0;
    await db.$transaction(async (tx) => {
      for (const slip of slips) {
        const due = dueByUser.get(slip.userId) ?? [];
        if (due.length === 0) continue;
        // The stored lines (manual edits included) are the base; the stale
        // rounding line is cleaned and re-derived by withRoundingLine after
        // the adjustments land (replaces, never duplicates).
        const applied = applyAdjustments(
          { earnings: parsePayslipLines(slip.earnings), deductions: parsePayslipLines(slip.deductions) },
          due,
          run.period,
        );
        if (applied.consumed.length === 0 && applied.skipped.length === 0) continue;
        for (const c of applied.consumed) {
          const row = due.find((r) => r.id === c.id);
          if (row) consumedEntries.push({ row, final: c.final });
        }
        for (const s of applied.skipped) skipById.set(s.id, s.reason);
        const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, roundingMode);
        const { gross, net } = payslipTotals(finalEarnings, deductions);
        await tx.payslip.update({
          where: { id: slip.id },
          data: {
            earnings: JSON.stringify(finalEarnings),
            deductions: JSON.stringify(deductions),
            gross,
            net,
            version: slip.version + 1,
          },
        });
        slipsTouched++;
      }
      for (const row of noSlipSkips) {
        skipById.set(row.id, `no payslip for the employee in the ${run.period} run`);
      }
      for (const { row, final } of consumedEntries) {
        await tx.payAdjustment.update({
          where: { id: row.id },
          data: {
            status: final ? "CONSUMED" : "PENDING",
            lastConsumedPeriod: run.period,
            consumedRunId: run.id,
          },
        });
      }
      for (const [id, reason] of skipById) {
        await tx.payAdjustment.update({ where: { id }, data: { status: "SKIPPED", skipReason: reason } });
      }
    });

    const appliedCount = consumedEntries.length;
    const skippedCount = skipById.size;
    if (appliedCount > 0 || skippedCount > 0) {
      await logAudit({
        actor: auth,
        action: "payroll.adjustments_applied",
        entityType: "PAYROLL_RUN",
        entityId: run.id,
        entityLabel: run.period,
        detail: `${auth.name} applied pending adjustments to the ${run.period} run — ${appliedCount} consumed onto ${slipsTouched} payslip(s)${skippedCount > 0 ? `, ${skippedCount} skipped with reason` : ""}.`,
      });
      revalidatePath("/");
    }
    return { applied: appliedCount, skipped: skippedCount, slipsTouched };
  });
}
