"use server";

// ---------------------------------------------------------------------------
// Payslip self-service (persona-audit P0-1 / D-02) — split from payroll.ts.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { getSessionOrThrow } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type { PayslipT } from "@/lib/types";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { runWindowEnd } from "@/lib/payroll/payroll-windows";
import { parsePayslipLines, round2 } from "@/lib/payroll/payroll-math";
import { computeRunningAggregates } from "@/lib/payroll/payslip-aggregates";
import { parseStatutorySnapshot } from "@/lib/payroll/nz/slip-statutory";
import { parseLopDetail } from "@/lib/payroll/lop-derivation";
import { openingEntriesForUsers } from "@/lib/payroll/opening-ytd";

// ---------------------------------------------------------------------------
// Payslip self-service (persona-audit P0-1 / D-02)
// ---------------------------------------------------------------------------

/** The signed-in employee's OWN payslips — LOCKED runs only.
 *
 * "Published" semantics, matching class-leading payroll ESS (greytHR only
 * exposes payslips after Payroll → Published Info; Rippling/Keka show stubs
 * once finalized): an OPEN run is still a draft HR may edit, so it must never
 * reach the employee. YTD is therefore a running net total over the same
 * locked-only basis per calendar year — draft money can never leak into an
 * employee-visible number.
 *
 * RBAC: no permission required — this is the caller's own data (the ESS
 * baseline every role holds, like leave self-service). The action takes zero
 * inputs, so the query is self-scoped by construction: there is no parameter
 * through which another user's slip could ever be requested. Unauthenticated
 * calls are rejected by getSessionOrThrow. */
export async function getMyPayslips(): Promise<ActionResult<PayslipT[]>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const [slips, profile, fiscalYearStartMonth] = await Promise.all([
      db.payslip.findMany({
        where: { userId: auth.userId, run: { status: "LOCKED" } },
        include: { run: { select: { period: true, workingDays: true, startDate: true, endDate: true } } },
      }),
      db.employeeProfile.findUnique({
        where: { userId: auth.userId },
        select: { jobTitle: true },
      }),
      getWorkspaceConfig().then((c) => c.workspace.fiscalYearStartMonth),
    ]);

    // P11 (PR-B09) — read-time aggregates through the ONE kernel both
    // surfaces share (self-service basis: LOCKED runs only, held/released
    // money carried forward, never accumulated). Ordering + year/month
    // attribution by the run's REAL window end (P10). P16 — the same fiscal
    // basis as the HR surface + this employee's opening rows, so the two
    // surfaces can never disagree.
    const runEndMs = (p: { run: { period: string; startDate: Date | null; endDate: Date | null } }) =>
      runWindowEnd(p.run.period, p.run.endDate)?.getTime() ?? 0;
    const openings = await openingEntriesForUsers([auth.userId], fiscalYearStartMonth);
    const aggregates = computeRunningAggregates(
      slips.map((s) => ({
        id: s.id,
        userId: s.userId,
        slipNo: s.slipNo,
        gross: s.gross,
        net: s.net,
        withholdStatus: s.withholdStatus,
        earnings: s.earnings,
        deductions: s.deductions,
        windowEndMs: runEndMs(s),
      })),
      { fiscalYearStartMonth, openings },
    );

    // P17 (PR-B25) — the employee's own live leave balances when the toggle
    // is on (read-time, current-year rows, latest year per type; names join
    // in memory — LeaveBalance has no LeaveType relation, just the id).
    const showLeaveBalances = (
      await getWorkspaceConfig()
    ).workspace.showLeaveBalancesOnSlip;
    const myBalances: { typeName: string; availableDays: number }[] = [];
    if (showLeaveBalances) {
      const latest = slips.reduce((m, s) => Math.max(m, runEndMs(s)), 0);
      const year = latest > 0 ? new Date(latest).getUTCFullYear() : new Date().getUTCFullYear();
      const [rows, types] = await Promise.all([
        db.leaveBalance.findMany({
          where: { userId: auth.userId, year: { gte: year } },
          select: { year: true, entitled: true, carriedOver: true, used: true, leaveTypeId: true },
          orderBy: { year: "desc" },
        }),
        db.leaveType.findMany({ select: { id: true, name: true } }),
      ]);
      const nameById = new Map(types.map((t) => [t.id, t.name]));
      const seen = new Set<string>();
      for (const r of rows) {
        // Dedupe by type id (not name): the freshest year per type wins.
        if (seen.has(r.leaveTypeId)) continue;
        seen.add(r.leaveTypeId);
        myBalances.push({
          typeName: nameById.get(r.leaveTypeId) ?? "(deleted type)",
          availableDays: round2(r.entitled + r.carriedOver - r.used),
        });
      }
    }

    return [...slips]
      .sort((a, b) => runEndMs(b) - runEndMs(a) || a.slipNo.localeCompare(b.slipNo))
      .map((p) => ({
        id: p.id,
        runId: p.runId,
        runPeriod: p.run.period,
        runStatus: "LOCKED" as const,
        runWorkingDays: p.run.workingDays,
        userId: auth.userId,
        userName: auth.name,
        jobTitle: profile?.jobTitle ?? "",
        slipNo: p.slipNo,
        earnings: parsePayslipLines(p.earnings),
        deductions: parsePayslipLines(p.deductions),
        note: p.note,
        lopDays: p.lopDays,
        lopSource: (p.lopSource === "MANUAL" ? "MANUAL" : "AUTO") as "AUTO" | "MANUAL",
        lopDetail: parseLopDetail(p.lopDetail),
        version: p.version,
        paidDays: p.paidDays ?? null,
        gross: p.gross,
        net: p.net,
        // P11 — the kernel's aggregates (self-service basis: locked runs
        // only).
        ytdNet: aggregates.get(p.id)?.ytdNet ?? p.net,
        ytdGross: aggregates.get(p.id)?.ytdGross ?? p.gross,
        mtdNet: aggregates.get(p.id)?.mtdNet ?? p.net,
        componentYtd: aggregates.get(p.id)?.componentYtd ?? [],
        // P16 — the fiscal basis behind these numbers (the modal's chip).
        fiscalYearStartMonth,
        // P17 — the employee's own live balances when the toggle is on.
        ...(showLeaveBalances ? { leaveBalances: myBalances } : {}),
        withholdStatus: (p.withholdStatus === "WITHHELD" || p.withholdStatus === "RELEASED" ? p.withholdStatus : "") as "" | "WITHHELD" | "RELEASED",
        // Phase 2 — the frozen statutory snapshot (null = pre-engine slip).
        statutory: parseStatutorySnapshot(p.statutory),
      }));
  });
}
