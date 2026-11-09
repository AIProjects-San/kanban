"use server";

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary withholding actions (the lite state
// machine's service half).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 8.
//
// createSalaryWithholding: one ACTIVE window per employee (overlaps are
// refused), fromPeriod never a LOCKED period (a hold only affects slips
// that do not exist yet — run creation/addPayslip stamp WITHHELD at birth,
// never retroactively).
//
// releaseSalaryWithholding: one transaction — every WITHHELD payslip of the
// employee flips RELEASED, each money-bearing one emits a WITHHELD_RELEASE
// PayAdjustment (the frozen stored net) into the chosen release period,
// and the window flips RELEASED (terminal). The money pays exactly once,
// through the P1 adapter — the same discipline every special payment rides.
// A SETTLED full-and-final freezes the exit money, so releasing for that
// employee is refused (the statement already accounted the held net).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseOrThrow } from "@/lib/validation";
import { createSalaryWithholdingSchema, releaseWithholdingSchema } from "@/lib/validation";
import {
  planWithholdingRelease,
  validateWithholdingWindow,
  windowsOverlap,
  withholdingReleaseLabel,
} from "@/lib/salary-withholding";
import type { SalaryWithholdingT } from "@/lib/types";

export async function listSalaryWithholdings(): Promise<ActionResult<SalaryWithholdingT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const [rows, users, heldSlips] = await Promise.all([
      db.salaryWithholding.findMany({ orderBy: { createdAt: "desc" } }),
      db.user.findMany({ select: { id: true, name: true } }),
      // The still-held money (WITHHELD slips are the live hold balance).
      db.payslip.findMany({
        where: { withholdStatus: "WITHHELD" },
        select: { userId: true, net: true },
      }),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const heldByUser = new Map<string, { count: number; total: number }>();
    for (const s of heldSlips) {
      const cur = heldByUser.get(s.userId) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total = Math.round((cur.total + s.net) * 100) / 100;
      heldByUser.set(s.userId, cur);
    }
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: nameById.get(r.userId) ?? "Unknown",
      fromPeriod: r.fromPeriod,
      untilPeriod: r.untilPeriod,
      reason: r.reason,
      status: r.status === "RELEASED" ? ("RELEASED" as const) : ("ACTIVE" as const),
      releasePeriod: r.releasePeriod || null,
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      heldSlipCount: heldByUser.get(r.userId)?.count ?? 0,
      heldTotal: heldByUser.get(r.userId)?.total ?? 0,
    }));
  });
}

export async function createSalaryWithholding(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createSalaryWithholdingSchema, input);

    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
    if (!user) throw new AuthorizationError("Employee not found.");

    const plan = validateWithholdingWindow({ fromPeriod: data.fromPeriod, untilPeriod: data.untilPeriod });
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    // A hold only affects slips that do not exist yet: a LOCKED fromPeriod
    // already paid its slips, so the hold would be a no-op pretending to
    // hold money (an OPEN fromPeriod run still gets addPayslip stamps).
    const fromRun = await db.payrollRun.findUnique({
      where: { period: data.fromPeriod },
      select: { status: true },
    });
    if (fromRun?.status === "LOCKED") {
      throw new AuthorizationError(
        `The ${data.fromPeriod} run is already locked (paid) — a hold can only start in a month whose payslips don't exist yet.`,
      );
    }

    // One ACTIVE window per employee: overlaps would double-hold periods.
    const active = await db.salaryWithholding.findMany({
      where: { userId: data.userId, status: "ACTIVE" },
    });
    for (const w of active) {
      if (windowsOverlap({ fromPeriod: w.fromPeriod, untilPeriod: w.untilPeriod }, data)) {
        throw new AuthorizationError(
          `An active hold already covers ${w.fromPeriod}–${w.untilPeriod ?? "open-ended"} — release it before holding again.`,
        );
      }
    }

    const row = await db.salaryWithholding.create({
      data: {
        userId: data.userId,
        fromPeriod: data.fromPeriod,
        untilPeriod: data.untilPeriod,
        reason: data.reason,
        status: "ACTIVE",
        createdById: auth.userId,
      },
    });

    await logAudit({
      actor: auth,
      action: "payroll.withholding_created",
      entityType: "SALARY_WITHHOLDING",
      entityId: row.id,
      entityLabel: `${user.name} — ${data.fromPeriod} to ${data.untilPeriod ?? "open-ended"}`,
      detail: `${auth.name} held ${user.name}'s salary from ${data.fromPeriod} through ${data.untilPeriod ?? "open-ended"}${data.reason ? ` — ${data.reason}` : ""}. Payslips created inside the window are computed but not paid until released.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function releaseSalaryWithholding(
  input: unknown,
): Promise<ActionResult<{ releasedSlips: number; adjustmentCount: number; total: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(releaseWithholdingSchema, input);

    const withholding = await db.salaryWithholding.findUnique({ where: { id: data.withholdingId } });
    if (!withholding) throw new AuthorizationError("Withholding not found.");
    if (withholding.status !== "ACTIVE") throw new AuthorizationError("This hold was already released.");

    // The release period must still be payable.
    const releaseRun = await db.payrollRun.findUnique({
      where: { period: data.releasePeriod },
      select: { status: true },
    });
    if (releaseRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.releasePeriod} run is already locked — pick a later release month.`);
    }

    // F2.1 — a settled FnF froze the exit money (the held net was a payable
    // line on it); releasing after settlement would double-pay it.
    const settledFnF = await db.fullAndFinalStatement.findFirst({
      where: { userId: withholding.userId, status: "SETTLED" },
      select: { id: true },
    });
    if (settledFnF) {
      throw new AuthorizationError(
        "This employee's full-and-final statement is settled — the held salary was accounted in the frozen settlement and cannot be released separately.",
      );
    }

    // The frozen held money: every WITHHELD slip of the employee, with its
    // run's period for the label.
    const heldSlips = await db.payslip.findMany({
      where: { userId: withholding.userId, withholdStatus: "WITHHELD" },
      include: { run: { select: { period: true } } },
      orderBy: { createdAt: "asc" },
    });
    const plan = planWithholdingRelease({
      slips: heldSlips.map((s) => ({ id: s.id, slipNo: s.slipNo, period: s.run.period, net: s.net })),
      releasePeriod: data.releasePeriod,
    });

    const user = await db.user.findUnique({
      where: { id: withholding.userId },
      select: { name: true },
    });

    await db.$transaction(async (tx) => {
      for (const row of plan.rows) {
        await tx.payAdjustment.create({
          data: {
            userId: withholding.userId,
            sourceType: "WITHHOLDING_RELEASE",
            sourceId: row.payslipId,
            componentCode: "",
            label: withholdingReleaseLabel(row.slipNo, row.period),
            side: "EARNING",
            recurrence: "ONE_SHOT",
            calcMode: "FIXED",
            amount: row.amount,
            period: data.releasePeriod,
            note: data.note || `Release of held salary from payslip ${row.slipNo} (${row.period})`,
            createdById: auth.userId,
          },
        });
      }
      // Every held slip flips RELEASED — including zero-net ones (their
      // hold is over even though they pay nothing).
      for (const s of heldSlips) {
        await tx.payslip.update({
          where: { id: s.id },
          data: { withholdStatus: "RELEASED" },
        });
      }
      await tx.salaryWithholding.update({
        where: { id: withholding.id },
        data: {
          status: "RELEASED",
          releasedById: auth.userId,
          releasedAt: new Date(),
          releasePeriod: data.releasePeriod,
        },
      });
    });

    await logAudit({
      actor: auth,
      action: "payroll.withholding_released",
      entityType: "SALARY_WITHHOLDING",
      entityId: withholding.id,
      entityLabel: `${user?.name ?? "Employee"} — ${plan.total.toLocaleString("en-NZ")} held`,
      detail: `${auth.name} released ${user?.name ?? "the employee"}'s held salary — ${plan.rows.length} payslip(s) totalling $${plan.total.toLocaleString("en-NZ")} pay as adjustment lines on the ${data.releasePeriod} run${plan.zeroNetSlips.length > 0 ? ` (${plan.zeroNetSlips.length} zero-net held slip(s) released without money)` : ""}${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { releasedSlips: heldSlips.length, adjustmentCount: plan.rows.length, total: plan.total };
  });
}
