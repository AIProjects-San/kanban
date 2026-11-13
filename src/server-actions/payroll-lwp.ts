"use server";

// ---------------------------------------------------------------------------
// P4 (PR-14/PR-B12, F3.1) — LWP correction reversal actions.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 4.
//
// Reversing N LOP days of a PAID slip refunds exactly what those days
// docked (the stored LOP line's per-day price) as an LWP_CREDIT
// PayAdjustment on a chosen payout period. Only LOCKED slips take
// corrections — an OPEN slip is edited directly (updatePayslip), which is
// the whole point of the OPEN state. The reversal cap (Σ reversed ≤ stored
// lopDays) is enforced from the adapter rows' sourceDays data; a slip
// cannot refund more days than it docked.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { parseOrThrow } from "@/lib/validation";
import { previewLwpCorrectionSchema, reverseLwpDaysSchema } from "@/lib/validation";
import { planLwpCorrection, lwpCreditLabel } from "@/lib/payroll/lwp-correction";
import { parsePayslipLines, LOP_LINE_KEY, round2 } from "@/lib/payroll/payroll-math";
import type { LwpCorrectionPreviewT } from "@/lib/types";

/** The stored facts + reversal state for one paid slip. Shared by the
 * preview and the writer so they can never disagree. */
async function factsForSlip(payslipId: string) {
  const slip = await db.payslip.findUnique({
    where: { id: payslipId },
    include: { run: { select: { id: true, period: true, status: true } } },
  });
  if (!slip) throw new AuthorizationError("Payslip not found.");
  if (slip.run.status !== "LOCKED") {
    throw new AuthorizationError("Only a PAID slip takes LWP corrections — an open run's slips are edited directly.");
  }

  // The stored LOP line — the truth of what was docked per day (whatever
  // edits happened before the lock).
  const lopLine = parsePayslipLines(slip.deductions).find((l) => l.key === LOP_LINE_KEY);
  const storedLopAmount = lopLine?.amount ?? 0;

  // Already-reversed days: Σ sourceDays of this slip's LWP_CREDIT rows.
  const priorCredits = await db.payAdjustment.findMany({
    where: { sourceType: "LWP_CREDIT", sourceId: payslipId },
    select: { sourceDays: true, status: true },
  });
  const alreadyReversedDays = priorCredits
    .filter((c) => c.status !== "SKIPPED")
    .reduce((s, c) => s + (c.sourceDays ?? 0), 0);

  return { slip, storedLopAmount, alreadyReversedDays };
}

/** The reversal facts for the correction modal (nothing written). */
export async function previewLwpCorrection(input: unknown): Promise<ActionResult<LwpCorrectionPreviewT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const data = parseOrThrow(previewLwpCorrectionSchema, input);
    const { slip, storedLopAmount, alreadyReversedDays } = await factsForSlip(data.payslipId);
    const user = await db.user.findUnique({ where: { id: slip.userId }, select: { name: true } });
    return {
      payslipId: slip.id,
      userId: slip.userId,
      userName: user?.name ?? "(former user)",
      slipNo: slip.slipNo,
      period: slip.run.period,
      storedLopDays: slip.lopDays,
      storedLopAmount,
      alreadyReversedDays: round2(alreadyReversedDays),
      reversibleDays: round2((slip.lopDays - alreadyReversedDays)),
      perDay: storedLopAmount > 0 && slip.lopDays > 0
        ? round2((storedLopAmount / slip.lopDays))
        : 0,
    };
  });
}

/** Reverse N LOP days of a paid slip: an LWP_CREDIT PayAdjustment (the
 * refund) on the payout period, carrying the days as sourceDays data. */
export async function reverseLwpDays(input: unknown): Promise<ActionResult<{ credit: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(reverseLwpDaysSchema, input);

    // The payout period must still be payable.
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.payoutPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.payoutPeriod} run is already locked — pick a later payout period.`);
    }

    const { slip, storedLopAmount, alreadyReversedDays } = await factsForSlip(data.payslipId);
    const plan = planLwpCorrection({
      storedLopDays: slip.lopDays,
      storedLopAmount,
      requestedDays: data.days,
      alreadyReversedDays,
    });
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    await db.payAdjustment.create({
      data: {
        userId: slip.userId,
        sourceType: "LWP_CREDIT",
        sourceId: slip.id,
        sourceDays: plan.days,
        componentCode: "",
        label: lwpCreditLabel(slip.run.period, slip.slipNo, plan.days),
        side: "EARNING",
        recurrence: "ONE_SHOT",
        calcMode: "FIXED",
        amount: plan.credit,
        period: data.payoutPeriod,
        note: data.note || `Reverses ${plan.days} LOP day(s) docked at $${plan.perDay.toLocaleString("en-NZ")}/day`,
        createdById: auth.userId,
      },
    });

    const user = await db.user.findUnique({ where: { id: slip.userId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.lwp_credit_created",
      entityType: "PAYSLIP",
      entityId: slip.id,
      entityLabel: slip.slipNo,
      detail: `${auth.name} reversed ${plan.days} LOP day(s) on ${user?.name ?? "an employee"}'s paid slip ${slip.slipNo} — $${plan.credit.toLocaleString("en-NZ")} ($${plan.perDay.toLocaleString("en-NZ")}/day) onto the ${data.payoutPeriod} run${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { credit: plan.credit };
  });
}
