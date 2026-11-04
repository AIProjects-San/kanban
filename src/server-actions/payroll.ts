"use server";

// ---------------------------------------------------------------------------
// Recruitment R7 — payroll server actions
// (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R7).
//
// RBAC: everything here is `payroll:manage` (ADMIN + HR) — salary data is
// the most sensitive information in the workspace; MANAGERs (interviewers on
// the hiring board) and MEMBERs never reach any of these paths.
//
// Model:
//   • SalaryStructure — the employee's standing ANNUAL components (same
//     shape as offers; lib/offer-math.ts resolves fixed / % of basic).
//     Created manually, or copied from the hire's SIGNED offer.
//   • PayrollRun — one month ("YYYY-MM"), OPEN → LOCKED. Creating a run
//     snapshots every ACTIVE structure into per-employee payslips
//     (monthly = annual ÷ 12).
//   • Payslip — monthly earnings/deductions lines, editable while the run
//     is OPEN (bonuses, fixes, LOP). Locking freezes the period; YTD is
//     computed at read time across the same-year periods.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { PayslipT, PayrollRunT, SalaryStructureT } from "@/lib/types";
import {
  saveSalaryStructureSchema,
  createPayrollRunSchema,
  updatePayslipSchema,
  lockPayrollRunSchema,
  addPayslipSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseComponents } from "@/lib/offer-math";
import {
  monthlyEarningsFromStructure,
  payslipTotals,
  withLopLine,
  parsePayslipLines,
  type PayslipLine,
} from "@/lib/payroll-math";
// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type StructureRow = {
  id: string; userId: string; components: string; notes: string;
  effectiveFrom: Date; isActive: boolean; createdAt: Date;
};

function serializeStructure(
  s: StructureRow,
  user: { name: string } | undefined,
  profile: { jobTitle: string; department: string } | undefined,
  fromOffer: boolean,
): SalaryStructureT {
  return {
    id: s.id,
    userId: s.userId,
    userName: user?.name ?? "Unknown",
    jobTitle: profile?.jobTitle ?? "",
    department: profile?.department ?? "",
    source: fromOffer ? "OFFER" : "MANUAL",
    components: parseComponents(s.components),
    notes: s.notes,
    effectiveFrom: s.effectiveFrom.toISOString(),
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Was this structure's employee hired through the pipeline with a signed
 * offer? (Display hint "copied from offer" — resolved per user.) */
async function signedOfferUserIds(): Promise<Set<string>> {
  const rows = await db.candidate.findMany({
    where: { status: "HIRED", userId: { not: null } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId).filter((u): u is string => !!u));
}

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

/** All structures (newest first) + the employee context, payroll:manage. */
export async function getSalaryStructures(): Promise<ActionResult<SalaryStructureT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.salaryStructure.findMany({ orderBy: { createdAt: "desc" } });
    const [users, profiles, offerUsers] = await Promise.all([
      db.user.findMany({ select: { id: true, name: true } }),
      db.employeeProfile.findMany({ select: { userId: true, jobTitle: true, department: true } }),
      signedOfferUserIds(),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    return rows.map((s) =>
      serializeStructure(
        s,
        userMap.get(s.userId),
        profileMap.get(s.userId),
        offerUsers.has(s.userId),
      ),
    );
  });
}

/** Create or revise an employee's salary structure. Saving a new ACTIVE
 * structure for a user deactivates their previous one (one active at a
 * time; history preserved with effectiveFrom). */
export async function saveSalaryStructure(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(saveSalaryStructureSchema, input);
    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
    if (!user) throw new AuthorizationError("Employee not found.");
    if (data.components.length === 0) {
      throw new AuthorizationError("A structure needs at least one component.");
    }
    if (!data.isActive) {
      throw new AuthorizationError("Deactivate a structure by saving its replacement — history must keep an active record.");
    }
    const payload = {
      userId: data.userId,
      components: JSON.stringify(data.components),
      notes: data.notes,
      effectiveFrom: data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00Z`) : new Date(),
      isActive: true,
      createdById: auth.userId,
    };
    let row: { id: string };
    if (data.id) {
      row = await db.salaryStructure.update({ where: { id: data.id }, data: payload });
    } else {
      // One ACTIVE structure per employee: retire the previous one.
      await db.salaryStructure.updateMany({
        where: { userId: data.userId, isActive: true },
        data: { isActive: false },
      });
      row = await db.salaryStructure.create({ data: payload });
    }
    await logAudit({
      actor: auth,
      action: "payroll.structure_saved",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: user.name,
      detail: `${auth.name} ${data.id ? "revised" : "created"} the salary structure for ${user.name} (${data.components.length} components, effective ${payload.effectiveFrom.toISOString().slice(0, 10)}).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Copy the employee's SIGNED offer components into a new ACTIVE structure —
 * the natural path right after "Mark joined" (research B: first payroll must
 * match the appointment letter). */
export async function createStructureFromOffer(input: { userId: string }): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const userId = String(input?.userId ?? "").trim();
    if (!userId) throw new AuthorizationError("An employee id is required.");
    const candidate = await db.candidate.findFirst({
      where: { userId, status: "HIRED" },
      select: { id: true, fullName: true },
    });
    if (!candidate) throw new AuthorizationError("No hired candidate links to this employee.");
    const offer = await db.offerRecord.findFirst({
      where: { candidateId: candidate.id, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
    });
    if (!offer) throw new AuthorizationError("No signed offer found for this employee.");
    const components = parseComponents(offer.components);
    if (components.length === 0) throw new AuthorizationError("The signed offer has no components to copy.");
    await db.salaryStructure.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    const row = await db.salaryStructure.create({
      data: {
        userId,
        components: offer.components,
        notes: `Copied from the signed offer (${offer.templateLabel || "custom"}).`,
        isActive: true,
        createdById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "payroll.structure_from_offer",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} copied ${candidate.fullName}'s signed offer (${offer.templateLabel || "custom"}) into a salary structure.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

// ---------------------------------------------------------------------------
// Runs + payslips
// ---------------------------------------------------------------------------

function slipNumber(period: string, seq: number): string {
  return `PS-${period}-${String(seq).padStart(3, "0")}`;
}

/** The runs list (newest period first) with per-run totals. */
export async function getPayrollRuns(): Promise<ActionResult<PayrollRunT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const runs = await db.payrollRun.findMany({
      include: { payslips: { select: { gross: true, net: true } } },
      orderBy: { period: "desc" },
    });
    const lockers = await db.user.findMany({
      where: { id: { in: runs.map((r) => r.lockedById).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const lockerMap = new Map(lockers.map((u) => [u.id, u.name]));
    return runs.map((r) => ({
      id: r.id,
      period: r.period,
      status: r.status as "OPEN" | "LOCKED",
      lockedBy: r.lockedById ? lockerMap.get(r.lockedById) ?? null : null,
      lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
      payslipCount: r.payslips.length,
      totalGross: Math.round(r.payslips.reduce((s, p) => s + p.gross, 0) * 100) / 100,
      totalNet: Math.round(r.payslips.reduce((s, p) => s + p.net, 0) * 100) / 100,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/** Create a monthly run and snapshot every ACTIVE structure into payslips
 * (monthly = annual ÷ 12). One run per period (unique). */
export async function createPayrollRun(input: unknown): Promise<ActionResult<{ id: string; payslipCount: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createPayrollRunSchema, input);
    const existing = await db.payrollRun.findUnique({ where: { period: data.period }, select: { id: true } });
    if (existing) throw new AuthorizationError(`A run for ${data.period} already exists.`);

    const structures = await db.salaryStructure.findMany({ where: { isActive: true } });
    if (structures.length === 0) {
      throw new AuthorizationError("No active salary structures — create at least one before running payroll.");
    }

    const run = await db.payrollRun.create({
      data: {
        period: data.period,
        status: "OPEN",
        createdById: auth.userId,
        payslips: {
          create: structures.map((s, i) => {
            const earnings = monthlyEarningsFromStructure(parseComponents(s.components));
            const { gross, net } = payslipTotals(earnings, []);
            return {
              userId: s.userId,
              slipNo: slipNumber(data.period, i + 1),
              earnings: JSON.stringify(earnings),
              deductions: "[]",
              gross,
              net,
            };
          }),
        },
      },
      include: { payslips: { select: { id: true } } },
    });

    await logAudit({
      actor: auth,
      action: "payroll.run_created",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} created the ${run.period} payroll run with ${run.payslips.length} payslips from the active salary structures.`,
    });
    revalidatePath("/");
    return { id: run.id, payslipCount: run.payslips.length };
  });
}

/** One run's payslips with names + YTD net (same-year periods up to and
 * including this run — OPEN periods count so the current month is live). */
export async function getPayrollRun(runId: string): Promise<ActionResult<{ run: PayrollRunT; payslips: PayslipT[] }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const id = String(runId ?? "").trim();
    const run = await db.payrollRun.findUnique({
      where: { id },
      include: { payslips: true },
    });
    if (!run) throw new AuthorizationError("Payroll run not found.");
    const year = run.period.slice(0, 4);

    // YTD basis: this user's payslips in same-year runs up to this period.
    const yearRuns = await db.payrollRun.findMany({
      where: { period: { startsWith: year } },
      select: { id: true, period: true },
    });
    const runIdsUpTo = yearRuns.filter((r) => r.period <= run.period).map((r) => r.id);
    const yearSlips = await db.payslip.findMany({
      where: { runId: { in: runIdsUpTo } },
      select: { userId: true, net: true },
    });
    const ytdByUser = new Map<string, number>();
    for (const s of yearSlips) {
      ytdByUser.set(s.userId, Math.round(((ytdByUser.get(s.userId) ?? 0) + s.net) * 100) / 100);
    }

    const [users, profiles] = await Promise.all([
      db.user.findMany({ select: { id: true, name: true } }),
      db.employeeProfile.findMany({ select: { userId: true, jobTitle: true } }),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u.name]));
    const jobMap = new Map(profiles.map((p) => [p.userId, p.jobTitle]));

    const payslips = run.payslips
      .slice()
      .sort((a, b) => a.slipNo.localeCompare(b.slipNo))
      .map((p) => ({
        id: p.id,
        runId: run.id,
        runPeriod: run.period,
        runStatus: run.status as "OPEN" | "LOCKED",
        userId: p.userId,
        userName: userMap.get(p.userId) ?? "Unknown",
        jobTitle: jobMap.get(p.userId) ?? "",
        slipNo: p.slipNo,
        earnings: parsePayslipLines(p.earnings),
        deductions: parsePayslipLines(p.deductions),
        note: p.note,
        lopDays: p.lopDays,
        gross: p.gross,
        net: p.net,
        ytdNet: ytdByUser.get(p.userId) ?? p.net,
      }));

    return {
      run: {
        id: run.id,
        period: run.period,
        status: run.status as "OPEN" | "LOCKED",
        lockedBy: null,
        lockedAt: run.lockedAt ? run.lockedAt.toISOString() : null,
        payslipCount: payslips.length,
        totalGross: Math.round(payslips.reduce((s, p) => s + p.gross, 0) * 100) / 100,
        totalNet: Math.round(payslips.reduce((s, p) => s + p.net, 0) * 100) / 100,
        createdAt: run.createdAt.toISOString(),
      },
      payslips,
    };
  });
}

/** Edit one payslip's lines while the run is OPEN. The LOP deduction line is
 * auto-managed from lopDays (gross × days / days-in-period); manual
 * deduction lines are kept as entered. gross/net recomputed server-side. */
export async function updatePayslip(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(updatePayslipSchema, input);
    const slip = await db.payslip.findUnique({
      where: { id: data.payslipId },
      include: { run: { select: { id: true, period: true, status: true } } },
    });
    if (!slip) throw new AuthorizationError("Payslip not found.");
    if (slip.run.status !== "OPEN") {
      throw new AuthorizationError(`The ${slip.run.period} run is locked — payslips are immutable once paid.`);
    }
    // A duplicated line key would break the LOP replace semantics — reject.
    const dupKey = (lines: PayslipLine[]) =>
      lines.some((l, i) => lines.findIndex((x) => x.key === l.key) !== i);
    if (dupKey(data.earnings) || dupKey(data.deductions)) {
      throw new AuthorizationError("Line keys must be unique (the loss-of-pay key is reserved).");
    }
    const grossBefore = slip.gross;
    const netBefore = slip.net;
    const deductions = withLopLine(data.deductions, payslipTotals(data.earnings, []).gross, data.lopDays, slip.run.period);
    const { gross, net } = payslipTotals(data.earnings, deductions);
    await db.payslip.update({
      where: { id: slip.id },
      data: {
        earnings: JSON.stringify(data.earnings),
        deductions: JSON.stringify(deductions),
        lopDays: data.lopDays,
        note: data.note,
        gross,
        net,
      },
    });
    await logAudit({
      actor: auth,
      action: "payroll.payslip_updated",
      entityType: "PAYSLIP",
      entityId: slip.id,
      entityLabel: slip.slipNo,
      detail: `${auth.name} updated payslip ${slip.slipNo}${data.lopDays > 0 ? ` (LOP ${data.lopDays} day${data.lopDays === 1 ? "" : "s"})` : ""}: gross ${grossBefore.toFixed(2)} → ${gross.toFixed(2)}, net ${netBefore.toFixed(2)} → ${net.toFixed(2)}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Add one employee's payslip to an OPEN run (joins mid-period — the
 * structure snapshot happens at add time, then HR adjusts/LOP-prorates). */
export async function addPayslip(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(addPayslipSchema, input);
    const run = await db.payrollRun.findUnique({ where: { id: data.runId } });
    if (!run) throw new AuthorizationError("Payroll run not found.");
    if (run.status !== "OPEN") throw new AuthorizationError("The run is locked — payslips are immutable once paid.");
    const existing = await db.payslip.findUnique({
      where: { runId_userId: { runId: run.id, userId: data.userId } },
      select: { id: true },
    });
    if (existing) throw new AuthorizationError("This employee already has a payslip in the run.");
    const structure = await db.salaryStructure.findFirst({
      where: { userId: data.userId, isActive: true },
    });
    if (!structure) throw new AuthorizationError("No active salary structure for this employee — create one first.");
    const count = await db.payslip.count({ where: { runId: run.id } });
    const earnings = monthlyEarningsFromStructure(parseComponents(structure.components));
    const { gross, net } = payslipTotals(earnings, []);
    let slip;
    try {
      slip = await db.payslip.create({
        data: {
          runId: run.id,
          userId: data.userId,
          slipNo: slipNumber(run.period, count + 1),
          earnings: JSON.stringify(earnings),
          deductions: "[]",
          gross,
          net,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Two HR users racing: recompute the sequence from the live count.
        const recount = await db.payslip.count({ where: { runId: run.id } });
        slip = await db.payslip.create({
          data: {
            runId: run.id,
            userId: data.userId,
            slipNo: slipNumber(run.period, recount + 1),
            earnings: JSON.stringify(earnings),
            deductions: "[]",
            gross,
            net,
          },
        });
      } else {
        throw err;
      }
    }
    await logAudit({
      actor: auth,
      action: "payroll.payslip_added",
      entityType: "PAYSLIP",
      entityId: slip.id,
      entityLabel: slip.slipNo,
      detail: `${auth.name} added payslip ${slip.slipNo} to the ${run.period} run.`,
    });
    revalidatePath("/");
    return { id: slip.id };
  });
}

/** Lock a run: the period was paid — every payslip in it becomes immutable
 * and the YTD baseline is frozen. */
export async function lockPayrollRun(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(lockPayrollRunSchema, input);
    const run = await db.payrollRun.findUnique({
      where: { id: data.runId },
      include: { payslips: { select: { net: true } } },
    });
    if (!run) throw new AuthorizationError("Payroll run not found.");
    if (run.status !== "OPEN") throw new AuthorizationError("The run is already locked.");
    if (run.payslips.length === 0) throw new AuthorizationError("Nothing to pay — the run has no payslips.");
    await db.payrollRun.update({
      where: { id: run.id },
      data: { status: "LOCKED", lockedById: auth.userId, lockedAt: new Date() },
    });
    const total = Math.round(run.payslips.reduce((s, p) => s + p.net, 0) * 100) / 100;
    await logAudit({
      actor: auth,
      action: "payroll.run_locked",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} locked the ${run.period} payroll run (paid) — ${run.payslips.length} payslips, net $${total.toLocaleString("en-NZ")}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** The Payroll view bundle: structures + runs in one call (the view fetches
 * the selected run's payslips separately via getPayrollRun). */
export async function getPayrollData(): Promise<ActionResult<{ structures: SalaryStructureT[]; runs: PayrollRunT[] }>> {
  return toResult(async () => {
    const [structuresRes, runsRes] = await Promise.all([getSalaryStructures(), getPayrollRuns()]);
    if (!structuresRes.ok) throw new AuthorizationError(structuresRes.error);
    if (!runsRes.ok) throw new AuthorizationError(runsRes.error);
    return { structures: structuresRes.data, runs: runsRes.data };
  });
}
