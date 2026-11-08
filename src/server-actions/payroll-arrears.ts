"use server";

// ---------------------------------------------------------------------------
// P3 (PR-13/PR-B11, F3.1) — arrears reverse-simulation actions.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 3.
//
// Toy-scale, honestly labeled: preview what a LOCKED period's slips would
// have paid under the employees' CURRENT active structures (the pure
// simulateArrearsRun kernel replays the run-creation pipeline over the
// stored snapshots — paidDays, lopDays, the run's denominator), then emit
// the POSITIVE per-employee deltas as ARREARS PayAdjustment rows onto a
// chosen payout period. Idempotent: a slip that already has an ARREARS row
// (its sourceId) never gets a second one — double arrears is double pay.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseOrThrow } from "@/lib/validation";
import { arrearsPreviewSchema, generateArrearsSchema } from "@/lib/validation";
import { getWorkspaceConfig } from "@/lib/config-loader";
import {
  simulateArrearsRun,
  arrearsComponents,
  arrearsAdjustmentLabel,
  type ArrearsSlipFacts,
} from "@/lib/arrears";
import { round2 } from "@/lib/payroll-math";
import type { ArrearsPreviewT } from "@/lib/types";

/** The shared read: one LOCKED run + its slips + the current structures,
 * simulated through the pure kernel. Both the preview and the generator
 * start here so they can never disagree. */
async function simulateForRun(runId: string) {
  const run = await db.payrollRun.findUnique({
    where: { id: runId },
    include: { payslips: { orderBy: { slipNo: "asc" } } },
  });
  if (!run) throw new AuthorizationError("Payroll run not found.");
  if (run.status !== "LOCKED") {
    throw new AuthorizationError("Arrears re-simulate a LOCKED period — pick a paid run.");
  }
  const structures = await db.salaryStructure.findMany({ where: { isActive: true } });
  const componentsByUser = new Map<string, ReturnType<typeof arrearsComponents> | null>();
  for (const s of structures) {
    // One ACTIVE structure per employee is the invariant; if data drift
    // ever violates it, the newest wins (deterministic by createdAt order
    // from findMany — the same order run creation consumes).
    if (!componentsByUser.has(s.userId)) componentsByUser.set(s.userId, arrearsComponents(s.components));
  }

  const facts: ArrearsSlipFacts[] = run.payslips.map((p) => ({
    payslipId: p.id,
    userId: p.userId,
    period: run.period,
    workingDays: run.workingDays,
    paidDays: p.paidDays ?? null,
    lopDays: p.lopDays,
    storedNet: p.net,
  }));
  const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;
  const { deltas } = simulateArrearsRun(facts, componentsByUser, roundingMode);

  // Idempotency: a slip that already carries an ARREARS row is done.
  const existing = await db.payAdjustment.findMany({
    where: { sourceType: "ARREARS", sourceId: { in: facts.map((f) => f.payslipId) } },
    select: { sourceId: true, period: true, status: true },
  });
  const arrangedSlipIds = new Set(existing.map((e) => e.sourceId));

  // Names for the preview table.
  const userIds = [...new Set(run.payslips.map((p) => p.userId))];
  const people = userIds.length > 0
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  const slipNoById = new Map(run.payslips.map((p) => [p.id, p.slipNo]));

  const rows: ArrearsPreviewT[] = deltas.map((d) => ({
    payslipId: d.payslipId,
    userId: d.userId,
    userName: names.get(d.userId) ?? "(former user)",
    slipNo: slipNoById.get(d.payslipId) ?? "",
    period: d.period,
    storedNet: d.storedNet,
    simulatedNet: d.simulatedNet,
    delta: d.delta,
    owed: d.owed,
    reason: d.reason,
    alreadyArranged: arrangedSlipIds.has(d.payslipId),
  }));

  return { run, rows };
}

/** Preview the arrears deltas for one LOCKED run (nothing written). */
export async function previewArrearsRun(input: unknown): Promise<ActionResult<ArrearsPreviewT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const data = parseOrThrow(arrearsPreviewSchema, input);
    const { rows } = await simulateForRun(data.runId);
    return rows;
  });
}

/** Emit the positive deltas as ARREARS PayAdjustment rows on the payout
 * period. One transaction: every row or none. Refuses slips that already
 * carry an ARREARS row (double arrears is double pay). */
export async function generateArrears(input: unknown): Promise<ActionResult<{ created: number; totalDelta: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(generateArrearsSchema, input);

    // The payout period must still be payable (a LOCKED run never takes
    // new money — the same rule createPayAdjustment enforces).
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.payoutPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.payoutPeriod} run is already locked — pick a later payout period.`);
    }

    const { run, rows } = await simulateForRun(data.runId);
    const payable = rows.filter((r) => r.owed && !r.alreadyArranged);
    const arranged = rows.filter((r) => r.owed && r.alreadyArranged);
    if (arranged.length > 0) {
      throw new AuthorizationError(
        `${arranged.length} slip(s) in this run already have arrears arranged (e.g. ${arranged[0].slipNo}) — a slip cannot be paid arrears twice.`,
      );
    }
    if (payable.length === 0) {
      return { created: 0, totalDelta: 0 };
    }

    const totalDelta = round2(payable.reduce((s, r) => s + r.delta, 0));
    await db.$transaction(async (tx) => {
      for (const r of payable) {
        await tx.payAdjustment.create({
          data: {
            userId: r.userId,
            sourceType: "ARREARS",
            sourceId: r.payslipId,
            componentCode: "",
            label: arrearsAdjustmentLabel(run.period, r.slipNo),
            side: "EARNING",
            recurrence: "ONE_SHOT",
            calcMode: "FIXED",
            amount: r.delta,
            period: data.payoutPeriod,
            note: `Re-simulated under the current structure: paid $${r.storedNet.toLocaleString("en-NZ")}, should be $${r.simulatedNet.toLocaleString("en-NZ")}`,
            createdById: auth.userId,
          },
        });
      }
    });

    await logAudit({
      actor: auth,
      action: "payroll.arrears_generated",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} generated arrears for the ${run.period} run — ${payable.length} employee(s), $${totalDelta.toLocaleString("en-NZ")} onto the ${data.payoutPeriod} run (re-simulated under the current structures; positive deltas only).`,
    });
    revalidatePath("/");
    return { created: payable.length, totalDelta };
  });
}
