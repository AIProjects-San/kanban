"use server";

// ---------------------------------------------------------------------------
// P5 (PR-15–18, PR-B04, F3.2) — flexible-benefits actions.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 5.
//
// The mini-ledger: elections are the standing input (yearly, capped by the
// structure's maxBenefits — re-election replaces), every run LOCK writes
// +ACCRUAL rows (annual ÷ 12, paid-days-scaled — payroll.ts's lock hook),
// and an HR-filed claim consumes the accrued balance with a −CLAIM row +
// a BENEFIT_PAYOUT PayAdjustment in ONE transaction (single-step and
// audited — F2.8 generalizes the member-claim flow to expenses).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { parseOrThrow } from "@/lib/validation";
import { electBenefitSchema, claimBenefitSchema, cancelBenefitElectionSchema } from "@/lib/validation";
import { planBenefitElection, planBenefitClaim, benefitBalance, benefitPayoutLabel } from "@/lib/payroll/benefits";
import type { BenefitsOverviewT } from "@/lib/types";
import { round2 } from "@/lib/shared/money";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The Benefits panel's data: this year's elections with live balances,
 * per-employee caps, and the payout queue (claim adjustments). */
export async function getBenefitsOverview(input?: { year?: number }): Promise<ActionResult<BenefitsOverviewT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const year = input?.year ?? new Date().getUTCFullYear();

    const [elections, accrualGroups, structures] = await Promise.all([
      db.benefitElection.findMany({ where: { year }, orderBy: { createdAt: "desc" } }),
      db.benefitAccrual.groupBy({
        by: ["userId", "componentCode"],
        where: { year },
        _sum: { delta: true },
      }),
      db.salaryStructure.findMany({ where: { isActive: true }, select: { userId: true, maxBenefits: true } }),
    ]);
    const capByUser = new Map(structures.map((s) => [s.userId, s.maxBenefits]));

    const userIds = [...new Set(elections.map((e) => e.userId))];
    const people = userIds.length > 0
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    const balanceBy = new Map(
      accrualGroups.map((g) => [`${g.userId}|${g.componentCode}`, g._sum.delta ?? 0]),
    );

    return {
      year,
      rows: elections.map((e) => ({
        id: e.id,
        userId: e.userId,
        userName: names.get(e.userId) ?? "(former user)",
        year: e.year,
        componentCode: e.componentCode,
        label: e.label || e.componentCode,
        annualAmount: e.annualAmount,
        status: (e.status === "CANCELLED" ? "CANCELLED" : "ACTIVE") as "ACTIVE" | "CANCELLED",
        cap: capByUser.get(e.userId) ?? 0,
        balance: round2(balanceBy.get(`${e.userId}|${e.componentCode}`) ?? 0),
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Election writer (yearly, capped, replace-on-re-elect)
// ---------------------------------------------------------------------------

export async function electBenefit(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(electBenefitSchema, input);

    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
    if (!user) throw new AuthorizationError("Employee not found.");
    const structure = await db.salaryStructure.findFirst({
      where: { userId: data.userId, isActive: true },
      select: { maxBenefits: true },
    });
    if (!structure) {
      throw new AuthorizationError("No active salary structure for this employee — the benefit cap cannot be read.");
    }

    // The cap rule: Σ ACTIVE annual amounts for the year (the same code's
    // current amount REPLACED by this election).
    const elections = await db.benefitElection.findMany({
      where: { userId: data.userId, year: data.year },
    });
    const currentAnnualTotal = elections
      .filter((e) => e.status === "ACTIVE")
      .reduce((s, e) => s + e.annualAmount, 0);
    const currentComponentAnnual = elections
      .filter((e) => e.componentCode === data.componentCode && e.status === "ACTIVE")
      .reduce((s, e) => s + e.annualAmount, 0);
    const plan = planBenefitElection({
      maxBenefits: structure.maxBenefits,
      currentAnnualTotal,
      currentComponentAnnual,
      annualAmount: data.annualAmount,
    });
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    const row = await db.benefitElection.upsert({
      where: { userId_year_componentCode: { userId: data.userId, year: data.year, componentCode: data.componentCode } },
      create: {
        userId: data.userId,
        year: data.year,
        componentCode: data.componentCode,
        label: data.label,
        annualAmount: plan.annualAmount,
        createdById: auth.userId,
      },
      update: {
        label: data.label,
        annualAmount: plan.annualAmount,
        // Re-electing a cancelled component re-activates it.
        status: "ACTIVE",
      },
    });

    await logAudit({
      actor: auth,
      action: "payroll.benefit_elected",
      entityType: "BENEFIT_ELECTION",
      entityId: row.id,
      entityLabel: `${user.name} — ${data.label || data.componentCode}`,
      detail: `${auth.name} set ${user.name}'s ${data.year} benefit election "${data.label || data.componentCode}" to $${plan.annualAmount.toLocaleString("en-NZ")}/year (accrues ÷12 at each run lock, paid-days-scaled)${structure.maxBenefits > 0 ? `, capped at $${structure.maxBenefits.toLocaleString("en-NZ")}` : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function cancelBenefitElection(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(cancelBenefitElectionSchema, input);
    const election = await db.benefitElection.findUnique({ where: { id: data.electionId } });
    if (!election) throw new AuthorizationError("Benefit election not found.");
    if (election.status !== "ACTIVE") throw new AuthorizationError("This election is already cancelled.");
    await db.benefitElection.update({ where: { id: election.id }, data: { status: "CANCELLED" } });
    const user = await db.user.findUnique({ where: { id: election.userId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.benefit_election_cancelled",
      entityType: "BENEFIT_ELECTION",
      entityId: election.id,
      entityLabel: `${user?.name ?? "an employee"} — ${election.label || election.componentCode}`,
      detail: `${auth.name} cancelled ${user?.name ?? "an employee"}'s ${election.year} benefit election "${election.label || election.componentCode}" — future accruals stop, the accrued balance stays claimable.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Claim writer (single-step, HR-filed; consumes the accrued balance and
// pays through the P1 adapter in one transaction)
// ---------------------------------------------------------------------------

export async function claimBenefit(input: unknown): Promise<ActionResult<{ adjustmentId: string; amount: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(claimBenefitSchema, input);

    // The payout period must still be payable.
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.payoutPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.payoutPeriod} run is already locked — pick a later payout period.`);
    }

    const election = await db.benefitElection.findUnique({
      where: { userId_year_componentCode: { userId: data.userId, year: data.year, componentCode: data.componentCode } },
    });
    if (!election) throw new AuthorizationError("No benefit election found for this employee-year-component.");

    // The accrued balance of this component (Σ ledger deltas).
    const groups = await db.benefitAccrual.groupBy({
      by: ["entryType"],
      where: { userId: data.userId, year: data.year, componentCode: data.componentCode },
      _sum: { delta: true },
    });
    const balance = benefitBalance(groups.map((g) => ({ delta: g._sum.delta ?? 0 })));
    const plan = planBenefitClaim({ balance, amount: data.amount });
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    const user = await db.user.findUnique({ where: { id: data.userId }, select: { name: true } });

    const adjustment = await db.$transaction(async (tx) => {
      // The money first (the P1 adapter row) so the consumption row can
      // carry its id as the source link; one transaction either way.
      const created = await tx.payAdjustment.create({
        data: {
          userId: data.userId,
          sourceType: "BENEFIT_PAYOUT",
          sourceId: "",
          componentCode: data.componentCode,
          label: benefitPayoutLabel(data.componentCode, election.label),
          side: "EARNING",
          recurrence: "ONE_SHOT",
          calcMode: "FIXED",
          amount: plan.amount,
          period: data.payoutPeriod,
          note: data.note || `Claim against accrued balance ($${balance.toLocaleString("en-NZ")} accrued)`,
          createdById: auth.userId,
        },
      });
      // The consumption row — append-only, linked to the payout.
      await tx.benefitAccrual.create({
        data: {
          userId: data.userId,
          year: data.year,
          componentCode: data.componentCode,
          entryType: "CLAIM",
          delta: -plan.amount,
          sourceId: created.id,
          period: data.payoutPeriod,
          note: data.note || `Benefit claim — ${election.label || election.componentCode}`,
        },
      });
      return created;
    });

    await logAudit({
      actor: auth,
      action: "payroll.benefit_claimed",
      entityType: "BENEFIT_ELECTION",
      entityId: election.id,
      entityLabel: `${user?.name ?? "an employee"} — ${election.label || election.componentCode}`,
      detail: `${auth.name} claimed $${plan.amount.toLocaleString("en-NZ")} of ${user?.name ?? "an employee"}'s accrued benefit "${election.label || election.componentCode}" (balance was $${balance.toLocaleString("en-NZ")}) onto the ${data.payoutPeriod} run${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { adjustmentId: adjustment.id, amount: plan.amount };
  });
}
