"use server";

// ---------------------------------------------------------------------------
// P6 (PR-20/PR-23, PR-T01) — the retention-bonus writer.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 6.
//
// A total amount, N monthly installments, one RECURRING PayAdjustment row
// (sourceType RETENTION_BONUS) through the P1 adapter — the equal-split
// rule with the last installment absorbing the rounding remainder. The
// employee is notified twice, best-effort: an in-app notification (the
// house pattern) and a RETENTION_BONUS outbox email (the INTERVIEW_INVITE
// pattern — queued in the same transaction, delivered outside it, never
// throwing). PR-22's one-off incentive is the P1 manual writer's INCENTIVE
// source (no dedicated flow needed).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit, queueOutboxMail, deliverOutboxMail } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { parseOrThrow } from "@/lib/validation";
import { createRetentionBonusSchema } from "@/lib/validation";
import { planRetentionBonus, periodPlusMonths, retentionBonusLabel } from "@/lib/payroll/retention-bonus";

export async function createRetentionBonus(input: unknown): Promise<ActionResult<{ adjustmentId: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createRetentionBonusSchema, input);

    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true, email: true } });
    if (!user) throw new AuthorizationError("Employee not found.");

    // The first payout period must still be payable.
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.firstPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.firstPeriod} run is already locked — pick a later first period.`);
    }

    const plan = planRetentionBonus({ totalAmount: data.totalAmount, installments: data.installments });
    if (!plan.ok) throw new AuthorizationError(plan.reason);
    const endPeriod = periodPlusMonths(data.firstPeriod, data.installments - 1);

    // The split is honest money: installments > 1 with a distinct last
    // installment cannot ride ONE fixed-amount RECURRING row — write one
    // row per installment instead (each ONE_SHOT, its own period), all in
    // one transaction. Installments == 1 rides a single ONE_SHOT row too —
    // one code path, no special cases.
    const rows = Array.from({ length: data.installments }, (_, i) => ({
      period: periodPlusMonths(data.firstPeriod, i),
      amount: i === data.installments - 1 ? plan.lastInstallment : plan.perInstallment,
    }));

    const subject = "Retention bonus";
    const text = [
      `Hi ${user.name},`,
      "",
      `A retention bonus of $${data.totalAmount.toLocaleString("en-NZ")} has been approved, paid in ${data.installments} monthly installment${data.installments === 1 ? "" : "s"} on the ${data.firstPeriod}–${endPeriod} payroll runs.`,
      data.note ? `Note: ${data.note}` : "",
      "",
      "— Fernly",
    ].filter(Boolean).join("\n");

    const adjustmentId = await db.$transaction(async (tx) => {
      let firstId = "";
      for (const row of rows) {
        const created = await tx.payAdjustment.create({
          data: {
            userId: data.userId,
            sourceType: "RETENTION_BONUS",
            sourceId: "",
            componentCode: "",
            label: retentionBonusLabel(user.name),
            side: "EARNING",
            recurrence: "ONE_SHOT",
            calcMode: "FIXED",
            amount: row.amount,
            period: row.period,
            note: data.note || `Installment ${rows.indexOf(row) + 1} of ${data.installments} ($${data.totalAmount.toLocaleString("en-NZ")} total)`,
            createdById: auth.userId,
          },
        });
        if (!firstId) firstId = created.id;
      }
      // PR-T01 — the notification email rides the outbox: queued in the
      // same transaction (no email without its money), delivered outside.
      const outboxRow = await queueOutboxMail(tx, {
        kind: "RETENTION_BONUS",
        toAddress: user.email,
        subject,
        text,
        sentById: auth.userId,
      });
      return { firstId, outboxRowId: outboxRow.id };
    });

    // Deliver outside the transaction — provider I/O never holds a lock
    // and never throws into the business write (the S17 discipline).
    await deliverOutboxMail(adjustmentId.outboxRowId, {
      toAddress: user.email,
      subject,
      html: `<p>${text.replace(/\n/g, "<br />")}</p>`,
      text,
    }).catch(() => undefined);

    // The in-app notification (best-effort, the house pattern).
    try {
      await db.notification.create({
        data: {
          recipientUserId: user.id,
          type: "SUCCESS",
          title: "Retention bonus approved",
          message: `$${data.totalAmount.toLocaleString("en-NZ")} over ${data.installments} installment${data.installments === 1 ? "" : "s"}, starting on the ${data.firstPeriod} run.`,
        },
      });
    } catch {
      // Never break the bonus on a notification failure.
    }

    await logAudit({
      actor: auth,
      action: "payroll.retention_bonus_created",
      entityType: "PAY_ADJUSTMENT",
      entityId: adjustmentId.firstId,
      entityLabel: `${user.name} — $${data.totalAmount.toLocaleString("en-NZ")}`,
      detail: `${auth.name} created a retention bonus for ${user.name} — $${data.totalAmount.toLocaleString("en-NZ")} in ${data.installments} installment${data.installments === 1 ? "" : "s"} on the ${data.firstPeriod}–${endPeriod} runs (the employee was notified)${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { adjustmentId: adjustmentId.firstId };
  });
}
