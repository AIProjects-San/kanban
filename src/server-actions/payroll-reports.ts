"use server";

// ---------------------------------------------------------------------------
// Payroll read/report surfaces (split from payroll.ts):
//   • P20 (PR-R01/PR-R02) — the per-run CSV exports (LOCKED runs only).
//   • P22 (PR-C01–04, PR-N01–06) — the read-time analytics panel.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { exportPayrollCsvSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { round2, parsePayslipLines } from "@/lib/payroll/payroll-math";
import { salaryRegisterCsv, bankRemittanceCsv } from "@/lib/payroll/payroll-csv";
import { runWindowEnd } from "@/lib/payroll/payroll-windows";
import { buildPayrollAnalytics, type PayrollAnalytics } from "@/lib/payroll/payroll-analytics";

/** P20 (PR-R01/PR-R02) — the per-run CSV exports (payroll:manage). LOCKED
 * runs only: paid money is the only money worth exporting — an OPEN run's
 * numbers are drafts HR may still edit. The register lists every slip
 * (gross/deductions/net + LOP + withhold state); the bank remittance lists
 * the DISBURSED payments (WITHHELD nets never reach the bank file) with
 * the account column blank — Fernly stores no bank details, the employer's
 * bank maps accounts from its records. Both carry the non-statutory
 * disclaimer; the build is pure (lib/payroll/payroll-csv.ts, golden-file tested).
 * Audited: payroll.run_exported. */
export async function exportPayrollRunCsv(input: unknown): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(exportPayrollCsvSchema, input);
    const run = await db.payrollRun.findUnique({
      where: { id: data.runId },
      select: { id: true, period: true, status: true },
    });
    if (!run) throw new AuthorizationError("Payroll run not found.");
    if (run.status !== "LOCKED") {
      throw new AuthorizationError("Only paid (locked) runs export — an open run's numbers are still drafts.");
    }
    // The slips + the identity joins in memory (Payslip/User carry no
    // relations — the P17/P18 pattern).
    const slips = await db.payslip.findMany({
      where: { runId: run.id },
      select: {
        slipNo: true, userId: true, gross: true, net: true, lopDays: true,
        withholdStatus: true, deductions: true,
      },
      orderBy: { slipNo: "asc" },
    });
    const [users, profiles] = await Promise.all([
      db.user.findMany({ where: { id: { in: [...new Set(slips.map((s) => s.userId))] } }, select: { id: true, name: true } }),
      db.employeeProfile.findMany({ where: { userId: { in: [...new Set(slips.map((s) => s.userId))] } }, select: { userId: true, employeeNumber: true, jobTitle: true } }),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const rows = slips.map((s) => {
      const profile = profileByUser.get(s.userId);
      return {
        slipNo: s.slipNo,
        employeeNumber: profile?.employeeNumber ?? null,
        employeeName: nameById.get(s.userId) ?? "(deleted user)",
        jobTitle: profile?.jobTitle ?? "",
        gross: s.gross,
        deductions: round2(parsePayslipLines(s.deductions).reduce((sum, l) => sum + l.amount, 0)),
        net: s.net,
        lopDays: s.lopDays,
        withholdStatus: s.withholdStatus,
      };
    });
    const generatedAt = new Date();
    const csv = data.kind === "REGISTER"
      ? salaryRegisterCsv({ period: run.period, generatedAt, rows })
      : bankRemittanceCsv({ period: run.period, generatedAt, rows });
    const filename = data.kind === "REGISTER"
      ? `salary-register-${run.period}.csv`
      : `bank-remittance-${run.period}.csv`;
    await logAudit({
      actor: auth,
      action: "payroll.run_exported",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} exported the ${data.kind === "REGISTER" ? "salary register" : "bank remittance"} CSV for the ${run.period} run (${rows.length} payslip row(s)).`,
    });
    return { filename, csv, mime: "text/csv; charset=utf-8" };
  });
}

// ---------------------------------------------------------------------------
// P22 (PR-C01–04, PR-N01–06) — read-time payroll analytics
// ---------------------------------------------------------------------------

/** The Payroll view's analytics panel: the four charts (outgoing salary,
 * department-wise salary, designation-wise salary, benefit claims) and the
 * six number cards, over LOCKED runs only — draft money never reaches an
 * analytics surface (the same published-only basis as self-service).
 *
 * RBAC: payroll:manage (the view itself already requires it — this keeps the
 * action independently safe). Read-only: no audit row (the export gate audits
 * file downloads; reads are not side effects). */
export async function getPayrollAnalytics(): Promise<ActionResult<PayrollAnalytics>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");

    const [slipRows, structureCount, claimRows, incentiveRows] = await Promise.all([
      db.payslip.findMany({
        where: { run: { status: "LOCKED" } },
        select: {
          userId: true,
          gross: true,
          net: true,
          withholdStatus: true,
          run: { select: { period: true, endDate: true } },
        },
      }),
      db.salaryStructure.count({ where: { isActive: true } }),
      db.benefitAccrual.findMany({
        where: { entryType: "CLAIM" },
        select: { delta: true, period: true, createdAt: true },
      }),
      db.payAdjustment.findMany({
        where: { sourceType: "INCENTIVE" },
        select: { amount: true },
      }),
    ]);

    // The claims ledger stores negative deltas (the append-only discipline);
    // the kernel consumes magnitudes.
    const claims = claimRows.map((c) => ({
      amount: Math.abs(c.delta),
      // windowEndMs: the claim's consuming month — the stored period when
      // present (the locking run's period), else createdAt's month.
      windowEndMs: c.period
        ? runWindowEnd(c.period)?.getTime() ?? c.createdAt.getTime()
        : c.createdAt.getTime(),
    }));

    // Join the profile dimensions for the dimension charts (one read; users
    // without a profile keep the honest "No department" bucket).
    const profileRows = await db.employeeProfile.findMany({
      select: { userId: true, department: true, jobTitle: true },
    });
    const profileByUser = new Map(profileRows.map((p) => [p.userId, p]));
    const dimensionedSlips = slipRows.map((s) => {
      const profile = profileByUser.get(s.userId);
      return {
        userId: s.userId,
        gross: s.gross,
        net: s.net,
        withholdStatus: s.withholdStatus,
        department: profile?.department ?? "",
        jobTitle: profile?.jobTitle ?? "",
        windowEndMs: runWindowEnd(s.run.period, s.run.endDate)?.getTime() ?? 0,
      };
    });

    return buildPayrollAnalytics({
      slips: dimensionedSlips,
      claims,
      incentives: incentiveRows.map((i) => ({ amount: i.amount })),
      activeStructures: structureCount,
    });
  });
}
