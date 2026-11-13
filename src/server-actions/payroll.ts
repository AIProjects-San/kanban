"use server";

// ---------------------------------------------------------------------------
// Recruitment R7 — payroll server actions
// (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R7).
//
// Split: structures → payroll-structures.ts, adjustments →
// payroll-adjustments.ts, reports → payroll-reports.ts, self-service →
// payroll-self-service.ts. This file keeps the run + payslip + statutory
// core (the verify-phase-1a pins on it stay here).
//
// RBAC: everything here is `payroll:manage` (ADMIN + HR) — salary data is
// the most sensitive information in the workspace; MANAGERs (interviewers on
// the hiring board) and MEMBERs never reach any of these paths.
//
// Model:
//   • SalaryStructure — the employee's standing ANNUAL components (same
//     shape as offers; lib/hiring/offer-math.ts resolves fixed / % of basic).
//     Created manually, or copied from the hire's SIGNED offer.
//   • PayrollRun — one month ("YYYY-MM"), OPEN → LOCKED. Creating a run
//     snapshots every ACTIVE structure into per-employee payslips
//     (monthly = annual ÷ 12).
//   • Payslip — monthly earnings/deductions lines, editable while the run
//     is OPEN (bonuses, fixes, LOP). Locking freezes the period; YTD is
//     computed at read time across the same-year periods.
// ---------------------------------------------------------------------------
import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { Prisma, type SalaryStructure } from "@prisma/client";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { PayslipT, PayrollRunT, SalaryStructureT, LopDetailT } from "@/lib/types";
import {
  createPayrollRunSchema,
  updatePayslipSchema,
  lockPayrollRunSchema,
  addPayslipSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit, queueOutboxMail, deliverOutboxMail } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { parseComponents } from "@/lib/hiring/offer-math";
import { workingDaysBetween, paymentWindowBetween, type HolidayLookup } from "@/lib/hr/working-days";
import { deriveLopBreakdownBetween, parseLopDetail, type LopAttendanceMark, type LopLeaveSpan } from "@/lib/payroll/lop-derivation";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { getHolidayLookup } from "./hr-shared";
import { payslipEmailSubject, payslipEmailText, payslipEmailHtml } from "@/lib/payroll/payslip-email";
import {
  payslipTotals,
  lopBasisGross,
  withRoundingLine,
  withLopLine,
  daysInPeriod,
  parsePayslipLines,
  round2,
  isStatutoryLineKey,
  type PayslipLine,
} from "@/lib/payroll/payroll-math";
import { deriveSlipLines } from "@/lib/payroll/slip-derivation";
// P1 (PR-12/PR-B10, F2.3) — the universal adjustment adapter kernel.
import {
  isDueInPeriod,
  type PayAdjustmentRow,
} from "@/lib/payroll/pay-adjustment";
// P5 (PR-18, F3.2) — the benefits accrual pricing (lock hook).
import { accrualAmount } from "@/lib/payroll/benefits";
// P8 (PR-19/PR-B13, F3.3) — the salary-withholding hold-window predicate.
import { isPeriodHeld } from "@/lib/payroll/salary-withholding";
// P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge kernel.
import { sumOvertimeMinutes } from "@/lib/payroll/overtime-bridge";
// P10 (PR-B05) — the payroll-windows kernel: every cadence resolves to ONE
// window {start, end, periodKey}; period-string comparisons became window
// comparisons so mixed cadences stay chronological.
import {
  resolvePayrollWindow,
  runWindowEnd,
  runWindowStart,
  fiscalYearOf,
  type PayrollFrequency,
} from "@/lib/payroll/payroll-windows";
// P11 (PR-B09) — read-time payslip aggregates (YTD gross/net, MTD net,
// per-component YTD) — ONE kernel for both the HR and self-service reads.
// P16 (PR-11) — the kernel now also takes the fiscal-year basis + the SSA
// opening entries (both default to the pre-P16 behavior).
import { computeRunningAggregates } from "@/lib/payroll/payslip-aggregates";
import { openingEntriesForUsers } from "@/lib/payroll/opening-ytd";
// Phase 2 (engine wiring) — the NZ statutory engine meets the payroll run:
// the slip kernel (pure), the rate-set resolver (impure seam) and the error
// type every statutory failure surfaces as.
import { resolveNzRateSet, type NzTaxProfileRow } from "@/lib/payroll/nz/calculate";
import { NzStatutoryError, type NzPayFrequency } from "@/lib/payroll/nz/types";
// Phase 1B (G8) — effective-dated salary assignment resolution.
import {
  resolveAssignmentAt,
  assignmentsInForceWhere,
} from "@/lib/payroll/resolve-assignment";
import {
  classifyComponentsForStatutory,
  parseStatutorySnapshot,
  planSlipStatutory,
  withoutStatutoryLines,
  type ComponentTaxClassification,
  type SlipAutoEnrolment,
  type SlipStatutoryPlan,
} from "@/lib/payroll/nz/slip-statutory";
// Phase 1C (G2) — the GL posting engine (lock hook).
import { postPayrollRun } from "@/lib/accounting/post-payroll-run";
// The view bundle calls the structures module (split sibling).
import { getSalaryStructures } from "./payroll-structures";


// ---------------------------------------------------------------------------
// Phase 2 (engine wiring) — statutory context loading + auto-enrolment.
// ---------------------------------------------------------------------------

/** The active component catalog flattened into the engine's classification
 * (Task 3.3 mapping: which earning keys leave the taxable gross, which
 * deduction keys dock it pre-tax). `?? []` keeps the read robust against
 * partial mocks / resiliency paths. */
async function loadStatutoryClassification(): Promise<ComponentTaxClassification> {
  const rows = (await db.salaryComponent.findMany({
    where: { isActive: true },
    select: { code: true, taxApplicable: true, statutoryCategory: true, wageBaseRef: true },
  })) ?? [];
  return classifyComponentsForStatutory(rows);
}

/** EmployeeTaxProfile rows for the given users. Missing rows are FINE — the
 * slip plan falls back to the system-default posture (M / ACTIVE /
 * PERMANENT) and flags it in the snapshot. */
async function loadTaxProfileRows(userIds: string[]): Promise<Map<string, NzTaxProfileRow>> {
  if (userIds.length === 0) return new Map();
  const rows = (await db.employeeTaxProfile.findMany({
    where: { userId: { in: userIds } },
  })) ?? [];
  return new Map(rows.map((r) => [r.userId, r as unknown as NzTaxProfileRow]));
}

/** Persist one KiwiSaver auto-enrolment INSIDE the caller's transaction:
 * write the rate that applied (the rate-set default) as the explicit
 * election — sticky, the time rules never re-trigger (Task 1.2 design).
 * Guarded to ACTIVE rows with no election so a concurrent run (or a
 * recorded election) can never be overwritten. True when the election
 * landed (count > 0) — the audit entry only fires then.
 *
 * The caller hands us the plan's autoEnrol — non-null exactly when the
 * snapshot's kiwiSaver.autoEnrolTriggered flag fired (a 28-day TEMPORARY
 * or 3-month CASUAL_AGRICULTURAL time rule). */
async function persistAutoEnrolment(
  tx: Pick<Prisma.TransactionClient, "employeeTaxProfile">,
  entry: SlipAutoEnrolment,
): Promise<boolean> {
  const res = await tx.employeeTaxProfile.updateMany({
    where: { userId: entry.userId, kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null },
    data: { kiwiSaverEmployeeRate: entry.rate },
  });
  return (res?.count ?? 0) > 0;
}

/**
 * Phase 1A (Task 2.2) — persist the SYSTEM-GENERATED statutory lines onto
 * a slip's deduction set: the plan's lines — PAYE income tax, the ACC earner's
 * levy ("ACC earners' levy" on the slip) persisted as its own SEPARATE line
 * (never merged into PAYE), the KiwiSaver employee deduction and the
 * student-loan repayment — replace any stale statutory keys wholesale (the
 * isSystemGenerated discipline: these line keys are engine-owned, the
 * editor never submits them). Employer-side money (employer KiwiSaver +
 * ESCT) does NOT ride the deductions; it persists only in the statutory
 * snapshot and the Payslip columns (employerKiwiSaverGross /
 * employerEsct / employerKiwiSaverNet).
 */
function persistStatutoryLines(
  baseDeductions: PayslipLine[],
  plan: Pick<SlipStatutoryPlan, "lines"> | null,
): PayslipLine[] {
  const cleaned = withoutStatutoryLines(baseDeductions);
  if (!plan || plan.lines.length === 0) return cleaned;
  return [...cleaned, ...plan.lines];
}

/** Phase 1A — the Payslip columns that promote the statutory snapshot's
 * key facts for SQL-level aggregation (taxCodeApplied, statutoryRuleVersion
 * and the employer-contribution trio). Empty/null when no plan landed. */
function statutorySnapshotColumns(
  plan: SlipStatutoryPlan | null,
): {
  taxCodeApplied: string;
  statutoryRuleVersion: string;
  employerKiwiSaverGross: number | null;
  employerEsct: number | null;
  employerKiwiSaverNet: number | null;
} {
  if (!plan) {
    return {
      taxCodeApplied: "",
      statutoryRuleVersion: "",
      employerKiwiSaverGross: null,
      employerEsct: null,
      employerKiwiSaverNet: null,
    };
  }
  const ks = plan.snapshot.kiwiSaver;
  return {
    taxCodeApplied: plan.snapshot.taxCode,
    statutoryRuleVersion: plan.snapshot.ruleVersion,
    employerKiwiSaverGross: ks.employerGross || null,
    employerEsct: ks.esct || null,
    employerKiwiSaverNet: ks.employerNet || null,
  };
}

/** The audit entries for enrolments that actually landed (after commit —
 * the log must never describe money that rolled back). */
async function auditAutoEnrolments(
  actor: { userId: string; name: string; role: string },
  entries: Array<{ entry: SlipAutoEnrolment; slipNo: string; period: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const users = (await db.user.findMany({
    where: { id: { in: entries.map((e) => e.entry.userId) } },
    select: { id: true, name: true },
  })) ?? [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  for (const { entry, slipNo, period } of entries) {
    await logAudit({
      actor,
      action: "payroll.kiwisaver_auto_enrolled",
      entityType: "EMPLOYEE_TAX_PROFILE",
      entityId: entry.userId,
      entityLabel: nameById.get(entry.userId) ?? slipNo,
      detail: `KiwiSaver auto-enrolment triggered while paying the ${period} run (payslip ${slipNo}): ${entry.reason}. Election persisted at ${(entry.rate * 100).toLocaleString("en-NZ", { maximumFractionDigits: 2 })}% — sticky, the time rule never re-triggers.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Runs + payslips
// ---------------------------------------------------------------------------

function slipNumber(period: string, seq: number): string {
  return `PS-${period}-${String(seq).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// F1.4 — attendance→LOP derivation fetch
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1)
// ---------------------------------------------------------------------------

/** Per-user loss-of-pay days for a period, derived from attendance marks
 * (ABSENT / HALF_DAY) and approved leave (paid types shield the day, unpaid
 * types charge it — lib/payroll/lop-derivation.ts has the exact per-day semantics).
 * Charges only working days (weekends/holidays never charge); days with no
 * record and no leave charge 0 (unless PR-B07's ABSENT mode). Runs at
 * run/slip CREATION only — the value is then a snapshot on the payslip
 * (F1.1's never-re-derived discipline).
 * S5 (PR-B06) — also returns each user's PAID DAYS (the employment-window
 * working-day count from lib/hr/working-days.ts paymentWindow) so the caller
 * can scale earnings to the days actually employed. */
interface PayrollFacts {
  lopDays: number;
  paidDays: number;
  clippedFrom: boolean;
  clippedUntil: boolean;
  /** P15 (PR-06) — the creation-time charge breakdown (frozen onto the
   * slip's lopDetail); null when nothing was docked. */
  lopDetail: LopDetailT | null;
}

async function deriveLopDaysForUsers(
  userIds: string[],
  window: { start: Date; end: Date },
  holidays: HolidayLookup,
): Promise<Map<string, PayrollFacts>> {
  // PR-B07 (S4) — the workspace's unmarked-day policy rides every
  // derivation (IGNORED default = pre-S4 semantics byte-for-byte).
  // P17 (PR-B27) — the proration basis rides it too (HYBRID default = the
  // pre-P17 leave-wins walk byte-for-byte).
  const config = await getWorkspaceConfig();
  const unmarkedMode = config.workspace.unmarkedAttendanceMode;
  const basisMode = config.workspace.lopBasisMode;
  const result = new Map<string, PayrollFacts>();
  if (userIds.length === 0) return result;
  // P10 — the window is the RUN's (any cadence), not a parsed month.
  const start = window.start;
  const end = window.end;
  if (!(start <= end)) return result;

  // S4 — ALL statuses are read (not just ABSENT/HALF_DAY): in ABSENT mode a
  // PRESENT/WFH/ON_LEAVE record is the difference between "marked" and
  // "unmarked". Non-chargeable statuses still charge 0 in the pure kernel.
  // The employment window (hireDate → lastWorkingDay) scopes every charge.
  const [marks, leaveRows, profiles] = await Promise.all([
    db.attendanceRecord.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: start, lte: end },
      },
      select: { userId: true, date: true, status: true },
    }),
    db.leaveRequest.findMany({
      where: {
        userId: { in: userIds },
        status: "APPROVED",
        startDate: { lte: end },
        endDate: { gte: start },
      },
      select: { userId: true, startDate: true, endDate: true, leaveTypeId: true },
    }),
    db.employeeProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, hireDate: true, lastWorkingDay: true },
    }),
  ]);

  // Leave type facts per request. A missing type row (deleted type)
  // defaults to paid/fully-paid — never dock pay off missing master data.
  // P15 (PR-06): salaryFraction rides the span so partially-paid types
  // charge (1 − fraction) days, and code/name build the lopDetail rows.
  const typeIds = [...new Set(leaveRows.map((r) => r.leaveTypeId))];
  const types = typeIds.length > 0
    ? await db.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, paid: true, salaryFraction: true, code: true, name: true } })
    : [];
  const typeById = new Map(types.map((t) => [t.id, t]));

  const byUser = new Map<string, { marks: LopAttendanceMark[]; spans: LopLeaveSpan[]; opts: { unmarkedMode: "IGNORED" | "ABSENT"; basisMode: "HYBRID" | "LEAVE" | "ATTENDANCE"; employmentFrom: Date | null; employmentUntil: Date | null } }>();
  for (const u of userIds) byUser.set(u, { marks: [], spans: [], opts: { unmarkedMode, basisMode, employmentFrom: null, employmentUntil: null } });
  for (const mk of marks) byUser.get(mk.userId)?.marks.push({ date: mk.date, status: mk.status });
  for (const lr of leaveRows) {
    const t = typeById.get(lr.leaveTypeId);
    byUser.get(lr.userId)?.spans.push({
      startDate: lr.startDate,
      endDate: lr.endDate,
      paid: t?.paid ?? true,
      salaryFraction: t?.salaryFraction ?? 1,
      key: lr.leaveTypeId,
    });
  }
  for (const p of profiles) {
    const entry = byUser.get(p.userId);
    if (entry) {
      entry.opts.employmentFrom = p.hireDate ?? null;
      entry.opts.employmentUntil = p.lastWorkingDay ?? null;
    }
  }
  for (const [u, { marks: userMarks, spans, opts }] of byUser) {
    // S5 — the payment window from the same employment facts the LOP walk
    // uses (one read, one truth): working days in [hireDate, LWD] ∩ window.
    const win = paymentWindowBetween(start, end, holidays, { from: opts.employmentFrom, until: opts.employmentUntil });
    // P15 (PR-06) — one walk produces the charge total AND the per-source
    // breakdown; the detail freezes onto the slip's lopDetail (null when
    // nothing was docked — an all-zero breakdown is noise, not honesty).
    const breakdown = deriveLopBreakdownBetween(start, end, holidays, userMarks, spans, opts);
    const detailLeaveRows: LopDetailT["leave"] = breakdown.leave.map((row) => {
      const t = typeById.get(row.key);
      // A deleted type with a live request still docks (the span carried
      // its facts); the detail row keeps the id and degrades gracefully.
      const paid = t?.paid ?? true;
      const fraction = t ? (t.paid ? t.salaryFraction : 0) : 1;
      return {
        leaveTypeId: row.key,
        code: t?.code ?? "—",
        name: t?.name ?? "(deleted leave type)",
        takenDays: row.takenDays,
        chargedDays: row.chargedDays,
        fraction,
        paid,
      };
    });
    const lopDetail: LopDetailT | null = breakdown.total > 0
      ? { absentDays: breakdown.absentDays, halfDays: breakdown.halfDays, unmarkedDays: breakdown.unmarkedDays, leave: detailLeaveRows }
      : null;
    result.set(u, {
      lopDays: breakdown.total,
      paidDays: win.paidDays,
      clippedFrom: win.clippedFrom,
      clippedUntil: win.clippedUntil,
      lopDetail,
    });
  }
  return result;
}

/** The runs list (newest window first — P10: sorted by the run's real
 * window END, falling back to the parsed period key; period strings do not
 * sort chronologically across cadences) with per-run totals. */
export async function getPayrollRuns(): Promise<ActionResult<PayrollRunT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const runs = await db.payrollRun.findMany({
      include: { payslips: { select: { gross: true, net: true } } },
      orderBy: { createdAt: "desc" },
    });
    const lockers = await db.user.findMany({
      where: { id: { in: runs.map((r) => r.lockedById).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const lockerMap = new Map(lockers.map((u) => [u.id, u.name]));
    return runs
      .map((r) => ({
        id: r.id,
        period: r.period,
        frequency: r.frequency as PayrollRunT["frequency"],
        startDate: r.startDate ? r.startDate.toISOString() : null,
        endDate: r.endDate ? r.endDate.toISOString() : null,
        payDate: r.payDate ? r.payDate.toISOString() : null,
        status: r.status as "OPEN" | "LOCKED",
        lockedBy: r.lockedById ? lockerMap.get(r.lockedById) ?? null : null,
        lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
        payslipCount: r.payslips.length,
        totalGross: round2(r.payslips.reduce((s, p) => s + p.gross, 0)),
        totalNet: round2(r.payslips.reduce((s, p) => s + p.net, 0)),
        workingDays: r.workingDays,
        createdAt: r.createdAt.toISOString(),
      }))
      .sort((a, b) => (runWindowEnd(b.period, b.endDate)?.getTime() ?? 0) - (runWindowEnd(a.period, a.endDate)?.getTime() ?? 0));
  });
}

/** Create a payroll run on ANY cadence (P10/PR-B05) and snapshot every
 * ACTIVE structure of the SAME frequency into payslips (amounts = annual ÷
 * windowsInYear — monthly = ÷ 12, byte-identical to the pre-P10 world). One
 * run per window (unique period key). F1.4: each slip's loss-of-pay days
 * are pre-derived from attendance + unpaid leave over the run's real window
 * (lopSource AUTO) and the LOP deduction line is materialized at creation.
 *
 * Phase 2 (engine wiring): the run resolves its statutory rate set at
 * creation (latest set whose effectiveFrom <= the window START — snapshot
 * discipline, later edits never rewrite a frozen run) and stores it on
 * PayrollRun.rateSetId. Every slip then gets its statutory computation
 * frozen at creation: employee-side deduction lines (paye/acc/ks/sl) ride
 * the deductions JSON between the adjustment kernel and the rounding line,
 * and the full result (incl. employer-side KiwiSaver + ESCT) snapshots onto
 * Payslip.statutory. A KiwiSaver time rule that fires (28-day / 3-month)
 * persists the default-rate election on EmployeeTaxProfile inside the SAME
 * transaction as the slip, with an audit entry after commit. No covering
 * set, or a DAILY cadence (IRD publishes no daily table) → rateSetId "" and
 * no statutory lines — byte-identical to the pre-engine behaviour.
 *
 * P13 (PR-B14/PR-09) — chunked batch processing with per-slip error
 * isolation: the FIRST 30 slips ride the run-creation transaction exactly
 * as before (≤30-employee workspaces are byte-identical: one transaction,
 * run + slips + adjustment consumption all-or-nothing); every slip BEYOND
 * the 30th is written in its OWN small transaction (the slip + its
 * adjustment consumption, S17 preserved per slip) with a per-slip try/catch
 * — one bad record can never abort the whole payroll. Failures are
 * collected, reported in the result + audit + toast (loud, never silent)
 * and the counts stay honest; a failed slip's adjustments stay PENDING so
 * the joiner path (addPayslip) can create the slip once the cause is fixed
 * (slip numbers are unique per structure order, so the retry takes the next
 * free number). No queue infra — the locked chunked-lite decision. */
export async function createPayrollRun(input: unknown): Promise<ActionResult<{ id: string; payslipCount: number; adjustmentsApplied: number; adjustmentsSkipped: number; failures: Array<{ userId: string; slipNo: string; reason: string }>; statutorySkipped: Array<{ userId: string; slipNo: string; reason: string }>; autoEnrolled: number; statutoryDefaulted: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createPayrollRunSchema, input);

    // P10 — the kernel resolves the cadence + anchor into ONE window; the
    // period key it returns is the unique human identifier. Invalid anchors
    // (2026-02-30) are refused here, before any read.
    const window = resolvePayrollWindow(data.frequency, data.anchorDate);
    if (!window) throw new AuthorizationError("Pick a valid anchor date (YYYY-MM-DD) inside the window.");

    // Phase 2 (payday filing) — the PAYDAY. The EI file is filed per
    // payday and the 2-working-day deadline runs from it, so it is an
    // explicit, editable input (the UI defaults it to the window end).
    // Guards: never before the window end (you cannot pay a period
    // before it finishes) and at most 7 days after it (a typo catcher —
    // a real payday lags the period end by a day or two at most).
    const payDateRaw = data.payDate ?? window.end.toISOString().slice(0, 10);
    const payMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDateRaw);
    let payDate: Date | null = payMatch
      ? new Date(Date.UTC(Number(payMatch[1]), Number(payMatch[2]) - 1, Number(payMatch[3])))
      : null;
    if (payDate && (payDate.getUTCMonth() !== Number(payMatch![2]) - 1 || payDate.getUTCDate() !== Number(payMatch![3]))) payDate = null;
    if (!payDate) throw new AuthorizationError("Pick a valid pay date (YYYY-MM-DD).");
    if (payDate.getTime() < window.end.getTime()) {
      throw new AuthorizationError(
        `The pay date (${payDateRaw}) cannot be before the period ends (${window.end.toISOString().slice(0, 10)}) — the payday is the day the payment is made.`,
      );
    }
    if (payDate.getTime() > window.end.getTime() + 7 * 86_400_000) {
      throw new AuthorizationError(
        `The pay date (${payDateRaw}) is more than 7 days after the period ends (${window.end.toISOString().slice(0, 10)}) — check for a typo.`,
      );
    }

    const existing = await db.payrollRun.findUnique({ where: { period: window.periodKey }, select: { id: true } });
    if (existing) throw new AuthorizationError(`A run for ${window.periodKey} already exists.`);

    // The benchmark's frequency-matched assignment: only structures whose
    // cadence matches the run's join it (one ACTIVE structure per employee).
    // Legacy rows default MONTHLY, so monthly runs see exactly the same set
    // as before. P14 (PR-04) — the optional employee filter restricts the
    // snapshot to the selected employees (the payroll-entry filter lite);
    // omitted/empty = every active structure of the cadence.
    const structures = await db.salaryStructure.findMany({
      where: {
        isActive: true,
        frequency: window.frequency,
        ...(data.userIds && data.userIds.length > 0 ? { userId: { in: data.userIds } } : {}),
      },
    });

    // Phase 1B (G8) — the effective-dated resolution: every assignment in
    // force at the window START (frequency-matched through its structure)
    // decides which structure prices that employee's slip. Employees whose
    // timeline was never materialised keep the pre-1B legacy read of their
    // one active structure — scripts/backfill-salary-assignments.ts makes
    // that fallback dead code in practice, but a workspace that never ran
    // the backfill must not stop paying people.
    const assignmentRows = await db.salaryStructureAssignment.findMany({
      where: {
        ...assignmentsInForceWhere(
          window.start,
          data.userIds && data.userIds.length > 0 ? data.userIds : undefined,
        ),
        structure: { frequency: window.frequency },
      },
      include: { structure: true },
      orderBy: { fromDate: "asc" },
    });
    // Latest fromDate wins per employee — @@unique(employeeId, fromDate)
    // makes same-date duplicates impossible, so asc order + overwrite keeps
    // the most recent row.
    const assignmentByUser = new Map<string, (typeof assignmentRows)[number]>();
    for (const row of assignmentRows) assignmentByUser.set(row.employeeId, row);
    // Hygiene (post-1B) — the legacy fallback is reserved for employees whose
    // timeline was NEVER materialised: zero SalaryStructureAssignment rows of
    // ANY date. An employee with rows but none in force at the window START
    // (e.g. their first assignment begins 2026-06-01 and this is the April
    // run) is SKIPPED for that window — never paid from the active structure,
    // which would price a pre-hire window with a post-hire salary. The probe
    // runs only when some active structure's owner is uncovered, so a fully
    // backfilled workspace pays zero extra queries.
    const uncovered = structures.filter((s) => !assignmentByUser.has(s.userId));
    let legacyFallback: SalaryStructure[] = uncovered;
    if (uncovered.length > 0) {
      const anyAssignmentRows = await db.salaryStructureAssignment.findMany({
        where: { employeeId: { in: uncovered.map((s) => s.userId) } },
        select: { employeeId: true },
      });
      const materialised = new Set(anyAssignmentRows.map((r) => r.employeeId));
      legacyFallback = uncovered.filter((s) => !materialised.has(s.userId));
    }
    // The effective pay sources, ONE per employee: the assignment's structure
    // (active or retired — the timeline row is authoritative for the window
    // it covers) or, uncovered AND unmaterialised, the legacy active
    // structure.
    const paidSources: SalaryStructure[] = [
      ...[...assignmentByUser.values()].map((a) => a.structure),
      ...legacyFallback,
    ];
    if (paidSources.length === 0) {
      throw new AuthorizationError(
        data.userIds && data.userIds.length > 0
          ? `No active ${window.frequency.toLowerCase()} salary structures for the selected employees — create or bulk-assign at least one before running ${window.frequency.toLowerCase()} payroll.`
          : `No active ${window.frequency.toLowerCase()} salary structures — create at least one before running ${window.frequency.toLowerCase()} payroll.`,
      );
    }

    // F1.1 — the run's holiday-aware LOP denominator over the WINDOW,
    // denormalized at creation and never re-derived: Mon–Fri days minus
    // holiday-calendar entries (half-days 0.5). An empty calendar yields the
    // plain Mon–Fri count — only PRE-F1.1 rows carry 0, and readers fall
    // back to the calendar length for those (daysInPeriod on monthly keys).
    const periodHolidays = await getHolidayLookup(window.start, window.end);
    const runWorkingDays = workingDaysBetween(window.start, window.end, periodHolidays);
    // S7 (PR-B23) — the workspace rounding policy rides run creation
    // (snapshot: flips affect future runs, never stored slips). P9 (PR-B26)
    // — the overtime payout knob rides the same read.
    const workspaceConfig = await getWorkspaceConfig();
    const roundingMode = workspaceConfig.workspace.payrollRoundingMode;
    const overtimePayEnabled = workspaceConfig.workspace.overtimePayEnabled;

    // Phase 2 (engine wiring) — resolve the run's statutory rate set (the
    // latest set whose effectiveFrom <= the window START, the PayrollRun
    // schema discipline) and load the per-employee tax profiles + the
    // component tax mapping ONCE for the whole run. DAILY cadences never
    // resolve: IRD publishes no daily table (nz/types.ts). No covering set
    // → rateSetId "" and no statutory lines (pre-engine behaviour).
    const rateSet = window.frequency !== "DAILY" ? await resolveNzRateSet(window.start) : null;
    // Phase 1A — the TaxYear row covering the run's window (the NZ
    // April–March year), stored for YTD-by-tax-year grouping.
    const taxYear = await db.taxYear.findFirst({
      where: { startDate: { lte: window.start }, endDate: { gte: window.start } },
    });
    const statutoryClassification = rateSet
      ? await loadStatutoryClassification()
      : classifyComponentsForStatutory([]);
    const taxProfileByUser = rateSet
      ? await loadTaxProfileRows(paidSources.map((s) => s.userId))
      : new Map<string, NzTaxProfileRow>();
    const statutorySkips: Array<{ userId: string; slipNo: string; reason: string }> = [];
    let statutoryDefaulted = 0;

    // F1.4 — derive each payslip's loss-of-pay days from attendance marks
    // (ABSENT / HALF_DAY) + unpaid approved leave, charged only on working
    // days of the run's window. Snapshot semantics: the value is written
    // once at creation (lopSource AUTO); corrections afterwards go through
    // a manual HR override in updatePayslip, never a silent re-derivation.
    // S5 (PR-B06) — the same facts carry each employee's PAID DAYS (the
    // employment-window working-day count); earnings scale by
    // paidDays / workingDays so mid-window joiners/leavers are paid for the
    // days they were employed (deliberate default-ON correctness fix;
    // pre-S5 rows read as full-period).
    const lopByUser = await deriveLopDaysForUsers(
      paidSources.map((s) => s.userId),
      { start: window.start, end: window.end },
      periodHolidays,
    );
    const autoLopCount = [...lopByUser.values()].filter((f) => f.lopDays > 0).length;
    const clippedCount = [...lopByUser.values()].filter((f) => f.clippedFrom || f.clippedUntil).length;

    // P9 (PR-B26, AT-09 lite) — the overtime bridge: sum the window's
    // DERIVED overtime minutes per employee (the S2 facts snapshotted on
    // the attendance rows). Only queried when the payout knob is on — the
    // disabled path is byte-identical to pre-P9.
    const otByUser = overtimePayEnabled
      ? sumOvertimeMinutes(
          await db.attendanceRecord.findMany({
            where: {
              date: { gte: window.start, lte: window.end },
              overtimeMinutes: { not: null },
            },
            select: { userId: true, overtimeMinutes: true },
          }),
        )
      : new Map<string, number>();

    // P1 (PR-12/PR-B10, F2.3) — the adjustment adapter consumption: every
    // PENDING row due in this window resolves onto its employee's payslip
    // through the pure two-pass kernel, and the row updates commit in the
    // SAME transaction as the run (a consumed row without its money, or
    // money without its row, is impossible — the S17 discipline).
    // P10 — no period-string pre-filter: due-ness is the window-aware
    // predicate's call (fetching all PENDING rows is bounded and lets
    // cross-cadence targets meet their first overlapping run).
    const pendingAdjustments = await db.payAdjustment.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    const dueByUser = new Map<string, PayAdjustmentRow[]>();
    for (const row of pendingAdjustments) {
      if (!isDueInPeriod(row, window.periodKey)) continue;
      const list = dueByUser.get(row.userId);
      if (list) list.push(row);
      else dueByUser.set(row.userId, [row]);
    }
    const slipUserIds = new Set(paidSources.map((s) => s.userId));
    // Due rows whose employee has no slip in this run: ONE_SHOT/OVERWRITE
    // windows may still come back (another cadence's run can meet them),
    // but a period that never recurs again is skipped with a visible
    // reason; RECURRING rows stay PENDING (a future run may yet include
    // them).
    const noSlipSkips = pendingAdjustments.filter(
      (row) => isDueInPeriod(row, window.periodKey) && !slipUserIds.has(row.userId) && row.recurrence !== "RECURRING",
    );
    type ConsumedEntry = { row: PayAdjustmentRow; final: boolean };
    const kernelSkips: Array<{ id: string; reason: string }> = [];

    // P8 (PR-19/PR-B13, F3.3) — ACTIVE hold windows stamp their slips
    // WITHHELD at birth: the slip is computed and frozen normally, but its
    // net is not disbursed (YTD/self-service exclude it) until the hold is
    // released — the release pays through the adapter, never the slip.
    const activeWithholdings = await db.salaryWithholding.findMany({ where: { status: "ACTIVE" } });
    const heldUserIds = new Set(
      activeWithholdings
        .filter((w) => isPeriodHeld({ fromPeriod: w.fromPeriod, untilPeriod: w.untilPeriod }, window.periodKey))
        .map((w) => w.userId),
    );

    // P10 — per-window amounts: annual ÷ windowsInYear of the window's
    // start year (MONTHLY = ÷ 12, the pre-P10 numbers exactly).
    const earningsYear = window.start.getUTCFullYear();
    // P13 — compute EVERY slip's data purely first (the map never throws:
    // the kernels are guarded), keeping each slip's adjustment consumption
    // attached so the chunked writes below can commit them per slip (S17).
    // Phase 2 — the statutory pass also plans here: one engine failure
    // (e.g. a broken STC certificate) skips that slip's statutory lines with
    // a visible reason instead of aborting the whole payroll; HR fixes the
    // profile and re-saves the slip while the run is OPEN.
    type SlipPlan = {
      data: {
        userId: string; slipNo: string; earnings: string; deductions: string;
        lopDays: number; lopSource: string; paidDays: number; gross: number; net: number; withholdStatus: string;
        lopDetail: Prisma.InputJsonValue | undefined;
        statutory: Prisma.InputJsonValue | undefined;
      };
      consumed: ConsumedEntry[];
      autoEnrol: SlipAutoEnrolment | null;
    };
    const slipPlans: SlipPlan[] = paidSources.map((s, i) => {
      const facts = lopByUser.get(s.userId)
        ?? { lopDays: 0, paidDays: runWorkingDays, clippedFrom: false, clippedUntil: false, lopDetail: null };
      const components = parseComponents(s.components);
      const lopDays = facts.lopDays;
      // The one structure→lines derivation (scale → structure deductions →
      // overtime → LOP → the two-pass adjustment kernel); the ordering
      // rationale lives in lib/payroll/slip-derivation.ts. The auto LOP line
      // is materialized at creation (net totals are honest immediately).
      const applied = deriveSlipLines({
        components,
        frequency: window.frequency,
        earningsYear,
        workingDays: runWorkingDays,
        paidDays: facts.paidDays,
        lopDays,
        periodKey: window.periodKey,
        overtime: { enabled: overtimePayEnabled, minutes: otByUser.get(s.userId) ?? null },
        adapterRows: dueByUser.get(s.userId) ?? [],
      });
      const consumed: ConsumedEntry[] = [];
      for (const c of applied.consumed) {
        const row = (dueByUser.get(s.userId) ?? []).find((r) => r.id === c.id);
        if (row) consumed.push({ row, final: c.final });
      }
      // Synthetic struct: ids never match a stored row — filtered out so
      // the run's failure summary stays about real adapter rows.
      kernelSkips.push(...applied.skipped.filter((sk: { id: string }) => !sk.id.startsWith("struct:")));
      // Phase 2 (engine wiring) — the statutory pass: employee-side lines
      // ride the deductions JSON (keys paye/acc/ks/sl) BETWEEN the
      // adjustment kernel and the rounding line, so gross/net math is
      // untouched and rounding wraps the FINAL net. planSlipStatutory runs
      // the pure aggregator calculateNzStatutoryWithSet — the core behind
      // the calculateNzStatutory entry point — against the run's frozen
      // rate set. Employer-side money (employer KiwiSaver, ESCT) lives only
      // in the snapshot + the Phase 1A Payslip columns. A KiwiSaver time
      // rule that fires rides the plan for in-transaction persistence.
      let statutorySnapshot: Prisma.InputJsonValue | undefined;
      let autoEnrol: SlipAutoEnrolment | null = null;
      let statutoryPlan: SlipStatutoryPlan | null = null;
      let deductionsPreRounding = withoutStatutoryLines(applied.deductions);
      if (rateSet) {
        try {
          const plan = planSlipStatutory({
            userId: s.userId,
            frequency: window.frequency as NzPayFrequency,
            payPeriodEnd: window.end,
            rateSet,
            profileRow: taxProfileByUser.get(s.userId) ?? null,
            earnings: applied.earnings,
            deductions: applied.deductions,
            classification: statutoryClassification,
          });
          statutorySnapshot = plan.snapshot as unknown as Prisma.InputJsonValue;
          autoEnrol = plan.autoEnrol;
          statutoryPlan = plan;
          if (plan.snapshot.defaultedProfile) statutoryDefaulted++;
          // Task 2.2 — the system-generated lines persist through the
          // shared helper (also used by updatePayslip).
          deductionsPreRounding = persistStatutoryLines(applied.deductions, plan);
        } catch (e) {
          // The slip still gets created — without statutory lines, loudly:
          // the reason is user-facing (engine guardrails) and updatePayslip
          // recomputes statutory once the profile is fixed.
          statutorySkips.push({
            userId: s.userId,
            slipNo: slipNumber(window.periodKey, i + 1),
            reason: e instanceof NzStatutoryError || e instanceof Error ? e.message : "unknown statutory error",
          });
        }
      }
      const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, deductionsPreRounding, roundingMode);
      const { gross, net } = payslipTotals(finalEarnings, deductions);
      return {
        data: {
          userId: s.userId,
          slipNo: slipNumber(window.periodKey, i + 1),
          earnings: JSON.stringify(finalEarnings),
          deductions: JSON.stringify(deductions),
          lopDays,
          lopSource: "AUTO",
          lopDetail: facts.lopDetail ? (facts.lopDetail as unknown as Prisma.InputJsonValue) : undefined,
          statutory: statutorySnapshot,
          // Phase 1A — the snapshot's key facts as real columns.
          ...statutorySnapshotColumns(statutoryPlan),
          paidDays: facts.paidDays,
          gross,
          net,
          withholdStatus: heldUserIds.has(s.userId) ? "WITHHELD" : "",
        },
        consumed,
        autoEnrol,
      };
    });

    // P13 — the first CHUNK rides the run-creation transaction (the
    // ≤30-employee path is byte-identical to the pre-P13 world: one
    // transaction, run + slips + consumption all-or-nothing).
    const CHUNK = 30;
    const firstChunk = slipPlans.slice(0, CHUNK);
    const overflow = slipPlans.slice(CHUNK);
    const consumedEntries: ConsumedEntry[] = firstChunk.flatMap((p) => p.consumed);
    // Phase 2 — enrolments that LANDED (filled by the transactions below;
    // audited only after commit).
    const enrolledInRun: Array<{ entry: SlipAutoEnrolment; slipNo: string }> = [];

    const run = await db.$transaction(async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          period: window.periodKey,
          frequency: window.frequency,
          startDate: window.start,
          endDate: window.end,
          payDate,
          status: "OPEN",
          createdById: auth.userId,
          workingDays: runWorkingDays,
          // Phase 2 — the run's frozen statutory rate set ("" = none
          // resolved: pre-engine rows keep this forever).
          rateSetId: rateSet?.id ?? "",
          // Phase 1A — the covering TaxYear ("" = none registered).
          taxYearId: taxYear?.id ?? "",
          payslips: {
            create: firstChunk.map((p) => p.data),
          },
        },
        include: { payslips: { select: { id: true } } },
      });

      // P1 — persist the consumption outcomes atomically with the run:
      // final consumptions flip CONSUMED; RECURRING intermediates watermark
      // lastConsumedPeriod and stay PENDING; refuses flip SKIPPED with the
      // kernel's reason (visible, never silent).
      for (const { row, final } of consumedEntries) {
        await tx.payAdjustment.update({
          where: { id: row.id },
          data: {
            status: final ? "CONSUMED" : "PENDING",
            lastConsumedPeriod: window.periodKey,
            consumedRunId: created.id,
          },
        });
      }
      const skipById = new Map<string, string>();
      for (const s of kernelSkips) skipById.set(s.id, s.reason);
      for (const row of noSlipSkips) skipById.set(row.id, `no payslip for the employee in the ${window.periodKey} run`);
      for (const [id, reason] of skipById) {
        await tx.payAdjustment.update({ where: { id }, data: { status: "SKIPPED", skipReason: reason } });
      }
      // Phase 2 — persist the KiwiSaver auto-enrolments the statutory pass
      // triggered, atomically with the slips they price (the election and
      // the money land together or not at all).
      for (const plan of firstChunk) {
        if (plan.autoEnrol && (await persistAutoEnrolment(tx, plan.autoEnrol))) {
          enrolledInRun.push({ entry: plan.autoEnrol, slipNo: plan.data.slipNo });
        }
      }
      return created;
    });

    // P13 — the overflow (>30th employee onward): each slip in its OWN
    // transaction (slip + its adjustment consumption — S17 per slip),
    // isolated per slip: a failure is recorded and NEVER aborts the rest.
    // The failed slip's adjustments stay untouched (PENDING), so addPayslip
    // can create the slip once the cause is fixed.
    const failures: Array<{ userId: string; slipNo: string; reason: string }> = [];
    let overflowApplied = 0;
    for (const plan of overflow) {
      try {
        await db.$transaction(async (tx) => {
          await tx.payslip.create({ data: { ...plan.data, runId: run.id } });
          for (const { row, final } of plan.consumed) {
            await tx.payAdjustment.update({
              where: { id: row.id },
              data: {
                status: final ? "CONSUMED" : "PENDING",
                lastConsumedPeriod: window.periodKey,
                consumedRunId: run.id,
              },
            });
          }
          // Phase 2 — the overflow slip's auto-enrolment, same atomic rule.
          if (plan.autoEnrol && (await persistAutoEnrolment(tx, plan.autoEnrol))) {
            enrolledInRun.push({ entry: plan.autoEnrol, slipNo: plan.data.slipNo });
          }
        });
        overflowApplied += plan.consumed.length;
      } catch (e) {
        failures.push({
          userId: plan.data.userId,
          slipNo: plan.data.slipNo,
          reason: isUniqueConstraintError(e)
            ? "a payslip already exists for this employee in the run (duplicate)"
            : e instanceof Error ? e.message : "unknown error",
        });
      }
    }

    // P13 — honest counts: the first chunk's consumptions + the overflow's
    // successfully committed ones; failures never count as applied.
    const adjustmentsApplied = consumedEntries.length + overflowApplied;
    const adjustmentsSkipped = new Set([...kernelSkips.map((s) => s.id), ...noSlipSkips.map((r) => r.id)]).size;
    const otSlipCount = overtimePayEnabled
      ? [...otByUser.keys()].filter((u) => slipUserIds.has(u)).length
      : 0;
    // Honest payslip count: the first chunk (nested with the run) + the
    // overflow's successes (failures excluded).
    const payslipCount = firstChunk.length + (overflow.length - failures.length);

    await logAudit({
      actor: auth,
      action: "payroll.run_created",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} created the ${run.period} (${window.frequency}) payroll run with ${payslipCount} payslips from the active ${window.frequency.toLowerCase()} salary structures${data.userIds && data.userIds.length > 0 ? ` (filtered to ${data.userIds.length} selected employee(s))` : ""}${overflow.length > 0 ? ` (${firstChunk.length} in the creation batch + ${overflow.length - failures.length} chunked beyond 30)` : ""}${failures.length > 0 ? ` — ${failures.length} payslip(s) FAILED with reasons: ${failures.map((f) => `${f.slipNo} (${f.reason})`).join("; ")}` : ""}${autoLopCount > 0 ? ` (${autoLopCount} with auto-derived loss-of-pay from attendance and unpaid leave)` : ""}${clippedCount > 0 ? ` (${clippedCount} scaled to mid-period employment windows)` : ""}${otSlipCount > 0 ? ` (${otSlipCount} with attendance overtime)` : ""}${heldUserIds.size > 0 ? ` (${heldUserIds.size} payslip(s) WITHHELD under an active salary hold)` : ""}${adjustmentsApplied > 0 || adjustmentsSkipped > 0 ? ` (${adjustmentsApplied} adjustment(s) consumed${adjustmentsSkipped > 0 ? `, ${adjustmentsSkipped} skipped with reason` : ""})` : ""}${rateSet ? ` Statutory: priced on "${rateSet.label}"${statutoryDefaulted > 0 ? `, ${statutoryDefaulted} slip(s) on system-default tax profiles (no IR330 recorded)` : ""}${statutorySkips.length > 0 ? `, ${statutorySkips.length} slip(s) created WITHOUT statutory lines (${statutorySkips.map((f) => `${f.slipNo}: ${f.reason}`).join("; ")})` : ""}${enrolledInRun.length > 0 ? `, ${enrolledInRun.length} KiwiSaver auto-enrolment(s) persisted` : ""}.` : " No statutory rate set covers the window — statutory lines were not computed."}`,
    });
    // Phase 2 — the enrolment audit entries (after commit: the log never
    // describes money that rolled back).
    await auditAutoEnrolments(auth, enrolledInRun.map((e) => ({ ...e, period: run.period })));
    revalidatePath("/");
    return { id: run.id, payslipCount, adjustmentsApplied, adjustmentsSkipped, failures, statutorySkipped: statutorySkips, autoEnrolled: enrolledInRun.length, statutoryDefaulted };
  });
}

/** One run's payslips with names + YTD net (windows ending in the same
 * FISCAL year (P16 — calendar year when fiscalYearStartMonth is 1), up to
 * and including this run — OPEN periods count so the current period is
 * live). */
export async function getPayrollRun(
  runId: string,
): Promise<ActionResult<{ run: PayrollRunT; payslips: PayslipT[]; unmarkedMode: "IGNORED" | "ABSENT"; roundingMode: "ROUND_2DP" | "ROUND_NET_NEAREST"; fiscalYearStartMonth: number; lopBasisMode: "HYBRID" | "LEAVE" | "ATTENDANCE" }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const id = String(runId ?? "").trim();
    const run = await db.payrollRun.findUnique({
      where: { id },
      include: { payslips: true },
    });
    if (!run) throw new AuthorizationError("Payroll run not found.");

    // P10 — YTD by window END dates: a run belongs to the calendar year its
    // window ENDS in, and "up to this run" compares end instants (identical
    // to the old period-string logic for monthly rows; chronological for
    // mixed cadences — a weekly run ending Nov 8 counts toward the November
    // month-end YTD).
    // P16 — the "year" is now the FISCAL year (Workspace.fiscalYearStartMonth,
    // default 1 = the calendar year, so the pre-P16 selection is
    // byte-identical): a run belongs to the fiscal year its window ends in.
    const runEnd = runWindowEnd(run.period, run.endDate);
    const fiscalYearStartMonth = (
      await getWorkspaceConfig()
    ).workspace.fiscalYearStartMonth;
    const year = runEnd ? fiscalYearOf(runEnd.getTime(), fiscalYearStartMonth) : Number(run.period.slice(0, 4));

    // YTD basis: every payslip in same-FISCAL-year runs up to this period.
    // P8 — WITHHELD/RELEASED slips never count: a held net is not paid, and
    // a released one already paid through its WITHHELD_RELEASE adjustment
    // (money counts exactly once, in the release period's slip) — the
    // aggregate kernel carries their last paid values forward instead of
    // accumulating them.
    const yearRuns = await db.payrollRun.findMany({
      select: { id: true, period: true, startDate: true, endDate: true },
    });
    const runIdsUpTo = yearRuns
      .filter((r) => {
        const end = runWindowEnd(r.period, r.endDate);
        return end != null && runEnd != null && fiscalYearOf(end.getTime(), fiscalYearStartMonth) === year && end.getTime() <= runEnd.getTime();
      })
      .map((r) => r.id);
    const windowEndByRun = new Map(
      yearRuns.map((r) => [r.id, runWindowEnd(r.period, r.endDate)?.getTime() ?? 0]),
    );
    // P11 (PR-B09) — read-time aggregates through the ONE kernel both
    // surfaces share: YTD gross/net, MTD net and per-component YTD.
    // P16 — the kernel gets the fiscal basis + the SSA opening rows
    // (structures whose effectiveFrom falls in a represented fiscal year,
    // active OR retired — an opening is a fact of what was earned, tied to
    // the fiscal year of the structure that carried it in).
    const yearSlips = await db.payslip.findMany({
      where: { runId: { in: runIdsUpTo } },
      select: { id: true, userId: true, slipNo: true, gross: true, net: true, withholdStatus: true, earnings: true, deductions: true, runId: true },
    });
    const openings = await openingEntriesForUsers(
      [...new Set(yearSlips.map((s) => s.userId))],
      fiscalYearStartMonth,
    );
    const aggregates = computeRunningAggregates(
      yearSlips.map((s) => ({
        id: s.id,
        userId: s.userId,
        slipNo: s.slipNo,
        gross: s.gross,
        net: s.net,
        withholdStatus: s.withholdStatus,
        earnings: s.earnings,
        deductions: s.deductions,
        windowEndMs: windowEndByRun.get(s.runId) ?? 0,
      })),
      { fiscalYearStartMonth, openings },
    );

    // P17 (PR-B25) — live leave balances on the slip when the workspace
    // toggle is on (read-time: the CURRENT year's rows, latest-first within
    // the year, never snapshotted). LeaveBalance carries no relation to
    // LeaveType (bare leaveTypeId) — names join in memory; a type deleted
    // after the balance row reads as "(deleted type)".
    const showLeaveBalances = (
      await getWorkspaceConfig()
    ).workspace.showLeaveBalancesOnSlip;
    const balancesByUser = new Map<string, { typeName: string; availableDays: number }[]>();
    if (showLeaveBalances && run.payslips.length > 0) {
      const runUserIds = [...new Set(run.payslips.map((p) => p.userId))];
      const [rows, types] = await Promise.all([
        db.leaveBalance.findMany({
          where: { userId: { in: runUserIds }, year: { gte: runEnd ? runEnd.getUTCFullYear() : 0 } },
          select: { userId: true, year: true, entitled: true, carriedOver: true, used: true, leaveTypeId: true },
          orderBy: { year: "desc" },
        }),
        db.leaveType.findMany({ select: { id: true, name: true } }),
      ]);
      const nameById = new Map(types.map((t) => [t.id, t.name]));
      const seenByUser = new Map<string, Set<string>>();
      for (const r of rows) {
        // Latest year per user×type wins (orderBy year desc; first row per
        // (userId, leaveTypeId) is the freshest — dedupe by type id, not
        // name, so renamed/duplicate names can't hide a type).
        const seen = seenByUser.get(r.userId) ?? new Set<string>();
        seenByUser.set(r.userId, seen);
        if (seen.has(r.leaveTypeId)) continue;
        seen.add(r.leaveTypeId);
        if (!balancesByUser.has(r.userId)) balancesByUser.set(r.userId, []);
        balancesByUser.get(r.userId)!.push({
          typeName: nameById.get(r.leaveTypeId) ?? "(deleted type)",
          availableDays: round2(r.entitled + r.carriedOver - r.used),
        });
      }
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
        runWorkingDays: run.workingDays,
        userId: p.userId,
        userName: userMap.get(p.userId) ?? "Unknown",
        jobTitle: jobMap.get(p.userId) ?? "",
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
        // P11 — the kernel's read-time aggregates (HR basis: every run of
        // the year up to and including this one, held/released money
        // carried forward, never accumulated).
        ytdNet: aggregates.get(p.id)?.ytdNet ?? p.net,
        ytdGross: aggregates.get(p.id)?.ytdGross ?? p.gross,
        mtdNet: aggregates.get(p.id)?.mtdNet ?? p.net,
        componentYtd: aggregates.get(p.id)?.componentYtd ?? [],
        // P16 — the fiscal basis behind these numbers (the modal's chip).
        fiscalYearStartMonth,
        // P17 — live balances when the toggle is on.
        ...(showLeaveBalances ? { leaveBalances: balancesByUser.get(p.userId) ?? [] } : {}),
        withholdStatus: (p.withholdStatus === "WITHHELD" || p.withholdStatus === "RELEASED" ? p.withholdStatus : "") as "" | "WITHHELD" | "RELEASED",
        // Phase 2 — the frozen statutory snapshot (null = pre-engine slip).
        statutory: parseStatutorySnapshot(p.statutory),
      }));

    return {
      run: {
        id: run.id,
        period: run.period,
        frequency: run.frequency as PayrollRunT["frequency"],
        startDate: run.startDate ? run.startDate.toISOString() : null,
        endDate: run.endDate ? run.endDate.toISOString() : null,
        payDate: run.payDate ? run.payDate.toISOString() : null,
        status: run.status as "OPEN" | "LOCKED",
        lockedBy: null,
        lockedAt: run.lockedAt ? run.lockedAt.toISOString() : null,
        payslipCount: payslips.length,
        totalGross: round2(payslips.reduce((s, p) => s + p.gross, 0)),
        totalNet: round2(payslips.reduce((s, p) => s + p.net, 0)),
        workingDays: run.workingDays,
        createdAt: run.createdAt.toISOString(),
      },
      payslips,
      // PR-B07 (S4) + PR-B23 (S7) — the CURRENT workspace policies for the
      // modal's honesty note + live preview (the derivation itself is a
      // creation-time snapshot).
      unmarkedMode: (await getWorkspaceConfig()).workspace.unmarkedAttendanceMode,
      roundingMode: (await getWorkspaceConfig()).workspace.payrollRoundingMode,
      // P17 (PR-B27) — the CURRENT proration basis for the modal's AUTO
      // note (same honesty-note pattern as unmarkedMode).
      lopBasisMode: (await getWorkspaceConfig()).workspace.lopBasisMode,
      // P16 — the YTD basis the aggregates were computed under (the modal's
      // "YTD (FY 2026/27)" chip renders ≠ calendar year).
      fiscalYearStartMonth,
    };
  });
}

/** Edit one payslip's lines while the run is OPEN. The LOP deduction line is
 * auto-managed from lopDays (gross × days / days-in-period); manual
 * deduction lines are kept as entered. gross/net recomputed server-side.
 * F1.4: changing lopDays flips lopSource to MANUAL (an audited override of
 * the run-creation derivation); saving the same value keeps the provenance.
 *
 * Phase 2 (engine wiring): on an engine run (rateSetId set) the statutory
 * lines are auto-managed EXACTLY like LOP — stripped from the submission,
 * recomputed from the edited earnings + the run's FROZEN rate set (a live
 * profile read, so a mid-run IR330 fix applies), re-inserted before the
 * rounding pass and re-snapshotted. The recompute refusing (broken STC
 * certificate etc.) refuses the SAVE: a slip whose tax lines cannot be
 * derived must never be silently stored without them. */
export async function updatePayslip(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(updatePayslipSchema, input);
    const slip = await db.payslip.findUnique({
      where: { id: data.payslipId },
      include: { run: { select: { id: true, period: true, status: true, workingDays: true, frequency: true, startDate: true, endDate: true, rateSetId: true } } },
    });
    if (!slip) throw new AuthorizationError("Payslip not found.");
    if (slip.run.status !== "OPEN") {
      throw new AuthorizationError(`The ${slip.run.period} run is locked — payslips are immutable once paid.`);
    }
    // F2.1 — settlement locks editing: a SETTLED full-and-final statement
    // froze this employee's exit money (the OPEN run's net was a payable
    // line on it), so the payslip behind that number is final too.
    const settledFnF = await db.fullAndFinalStatement.findFirst({
      where: { userId: slip.userId, status: "SETTLED" },
      select: { id: true },
    });
    if (settledFnF) {
      throw new AuthorizationError(
        "This employee's full-and-final statement is settled — their payslips are locked by the frozen settlement.",
      );
    }
    // F-R2 (S1) — optimistic lock: two HR editors of the same OPEN slip
    // must never silently overwrite each other. The modal carries the
    // version it loaded; anything else means another save landed first —
    // refuse, let them reopen to see the newer numbers.
    if (slip.version !== data.expectedVersion) {
      throw new AuthorizationError(
        `Payslip ${slip.slipNo} was saved by someone else while you were editing. Reopen it to see their changes, then re-apply your edit.`,
      );
    }
    // A duplicated line key would break the LOP replace semantics — reject.
    const dupKey = (lines: PayslipLine[]) =>
      lines.some((l, i) => lines.findIndex((x) => x.key === l.key) !== i);
    if (dupKey(data.earnings) || dupKey(data.deductions)) {
      throw new AuthorizationError("Line keys must be unique (the loss-of-pay key is reserved).");
    }
    // Payroll invariants (P0 fix, persona-audit PT-P0-2): LOP days can never
    // exceed the period's day count, and total deductions can never exceed
    // gross — otherwise a payslip can be saved with negative net pay
    // (verified live: 31 LOP days in a 30-day month produced net −$223.33).
    // F1.1: the denominator is the run's holiday-aware working-day count
    // when present (created post-F1.1), else the calendar month length —
    // matching what computeLop divides by below.
    // F1.4: halves are legal (HALF_DAY attendance) — round to 2 decimals so
    // float dust from the editor can never flip the changed-value check.
    const lopDays = round2(data.lopDays);
    const runWorkingDays = slip.run.workingDays;
    // S5 — a clipped slip's LOP bound is its PAID days (the employment
    // window), not the whole period: you cannot lose pay for days you were
    // not employed. Pre-S5 rows (paidDays null) keep the period bound.
    const paidDays = slip.paidDays ?? null;
    const periodDays = paidDays != null
      ? paidDays
      : runWorkingDays > 0 ? runWorkingDays : daysInPeriod(slip.run.period);
    if (lopDays > periodDays) {
      throw new AuthorizationError(
        paidDays != null && paidDays < (runWorkingDays > 0 ? runWorkingDays : daysInPeriod(slip.run.period))
          ? `Loss-of-pay days (${lopDays}) can't exceed the ${periodDays} paid days of ${slip.run.period} (this slip is clipped to the employment window).`
          : `Loss-of-pay days (${lopDays}) can't exceed the ${periodDays} working days of ${slip.run.period}.`,
      );
    }
    // F1.4 — provenance: a changed value is a manual override of the
    // run-creation derivation; an unchanged save keeps whatever the slip
    // already carries (AUTO or a previous MANUAL).
    const lopDaysChanged = lopDays !== slip.lopDays;
    const lopSource = lopDaysChanged ? "MANUAL" : (slip.lopSource === "MANUAL" ? "MANUAL" : "AUTO");
    // P15 (PR-06) — a manual override replaces the derivation, so its
    // frozen breakdown no longer describes the charge: drop it (the modal
    // honestly says "manually set by HR"). An unchanged save keeps it.
    const lopDetailWrite = lopDaysChanged ? Prisma.DbNull : undefined;
    const grossBefore = slip.gross;
    const netBefore = slip.net;
    // S6 — the LOP basis excludes window-exempt lines (flags ride the
    // submitted lines' snapshots). Phase 2 — the statutory keys are
    // auto-managed: strip them from the submission (a stale client must
    // never duplicate them) and let the recompute below replace them.
    const submittedDeductions = withoutStatutoryLines(data.deductions);
    const lopDeductions = withLopLine(submittedDeductions, lopBasisGross(data.earnings), lopDays, slip.run.period, runWorkingDays > 0 ? runWorkingDays : undefined);
    // S8 — statistical lines are display-only and never editable: the
    // stored snapshot's statistical rows ride along untouched (the editor
    // never submits them).
    const statisticalLines = parsePayslipLines(slip.earnings).filter((l) => l.statistical);
    const submittedEarnings = data.earnings.filter((l) => !l.statistical);
    // S7 — the rounding line is auto-managed on save too (replaced, never
    // duplicated); the editor never submits it.
    const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;
    // Phase 2 — recompute the statutory lines + snapshot from the EDITED
    // earnings: HR's changes (bonus, LOP) flow into PAYE/ACC/KiwiSaver/SL
    // before the run locks. The rate set stays the run's FROZEN one
    // (run.rateSetId — later rate edits never rewrite a run); the profile is
    // read live so a mid-run IR330 fix applies.
    let statutoryLines: PayslipLine[] = [];
    let statutorySnapshot: Prisma.InputJsonValue | undefined;
    let autoEnrol: SlipAutoEnrolment | null = null;
    let statutoryPlan: SlipStatutoryPlan | null = null;
    const runFrequency = (slip.run.frequency || "MONTHLY") as PayrollFrequency;
    const periodEnd = runWindowEnd(slip.run.period, slip.run.endDate);
    if (slip.run.rateSetId && runFrequency !== "DAILY" && periodEnd) {
      const rateSet = await resolveNzRateSet(periodEnd, slip.run.rateSetId);
      if (rateSet) {
        const [classification, profileRow] = await Promise.all([
          loadStatutoryClassification(),
          db.employeeTaxProfile.findUnique({ where: { userId: slip.userId } }),
        ]);
        try {
          const plan = planSlipStatutory({
            userId: slip.userId,
            frequency: runFrequency as NzPayFrequency,
            payPeriodEnd: periodEnd,
            rateSet,
            profileRow: (profileRow ?? null) as NzTaxProfileRow | null,
            earnings: [...submittedEarnings, ...statisticalLines],
            deductions: lopDeductions,
            classification,
          });
          statutoryLines = plan.lines;
          statutorySnapshot = plan.snapshot as unknown as Prisma.InputJsonValue;
          autoEnrol = plan.autoEnrol;
          statutoryPlan = plan;
        } catch (e) {
          // Fail loud, with the engine's own user-facing guardrail message:
          // the slip already carries statutory lines, so a save that cannot
          // re-derive them must never land.
          throw new AuthorizationError(
            `Statutory lines could not be recomputed for ${slip.slipNo} — fix the tax profile first. ${e instanceof Error ? e.message : "Unknown statutory error"}`,
          );
        }
      } else {
        // The run's rate set was deleted while the run was OPEN (the
        // archive-only guard covers LOCKED runs only): keep the STORED
        // statutory lines + snapshot untouched rather than silently dropping
        // the tax lines a frozen slip was priced with.
        statutoryLines = parsePayslipLines(slip.deductions).filter((l) => isStatutoryLineKey(l.key));
        statutorySnapshot = undefined; // undefined = column unchanged
      }
    }
    const deductionsPreRounding = statutoryLines.length > 0 ? [...lopDeductions, ...statutoryLines] : lopDeductions;
    const { earnings: finalEarnings, deductions } = withRoundingLine([...submittedEarnings, ...statisticalLines], deductionsPreRounding, roundingMode);
    const { gross, net } = payslipTotals(finalEarnings, deductions);
    if (net < 0) {
      const totalDeductions = gross - net;
      throw new AuthorizationError(
        `Total deductions (${totalDeductions.toFixed(2)}) exceed gross pay (${gross.toFixed(2)}) — net pay can't be negative. Reduce loss-of-pay days or deduction lines.`,
      );
    }
    await db.payslip.update({
      where: { id: slip.id },
      data: {
        earnings: JSON.stringify(finalEarnings),
        deductions: JSON.stringify(deductions),
        lopDays,
        lopSource,
        lopDetail: lopDetailWrite,
        note: data.note,
        gross,
        net,
        version: slip.version + 1,
        // Phase 2 — the recomputed statutory snapshot (undefined = the rate
        // set vanished mid-run; the stored snapshot stays).
        ...(statutorySnapshot !== undefined ? { statutory: statutorySnapshot } : {}),
        // Phase 1A — the promoted snapshot columns ride every recompute
        // (undefined plan = the rate set vanished: leave the stored columns).
        ...(statutoryPlan ? statutorySnapshotColumns(statutoryPlan) : {}),
      },
    });
    // Phase 2 — an enrolment that fired on the recompute persists here too
    // (same guarded write, same audit vocabulary as run creation).
    if (autoEnrol && (await persistAutoEnrolment(db, autoEnrol))) {
      await auditAutoEnrolments(auth, [{ entry: autoEnrol, slipNo: slip.slipNo, period: slip.run.period }]);
    }
    await logAudit({
      actor: auth,
      action: "payroll.payslip_updated",
      entityType: "PAYSLIP",
      entityId: slip.id,
      entityLabel: slip.slipNo,
      detail: `${auth.name} updated payslip ${slip.slipNo}${lopDays > 0 ? ` (LOP ${lopDays} day${lopDays === 1 ? "" : "s"}${lopDaysChanged ? `, manually set — the ${slip.lopSource === "MANUAL" ? "previous" : "auto-derived"} value was ${slip.lopDays} day${slip.lopDays === 1 ? "" : "s"}` : ""})` : ""}: gross ${grossBefore.toFixed(2)} → ${gross.toFixed(2)}, net ${netBefore.toFixed(2)} → ${net.toFixed(2)}.${statutorySnapshot ? ` Statutory lines recomputed (${statutoryLines.map((l) => `${l.key} ${l.amount.toFixed(2)}`).join(", ")}).` : ""}`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Add one employee's payslip to an OPEN run (joins mid-period — the
 * structure snapshot happens at add time, then HR adjusts/LOP-prorates).
 * F1.4: loss-of-pay days are derived from the attendance/unpaid-leave facts
 * already recorded for the period (a fresh joiner's pre-join days have no
 * records, so they charge 0 — pre-join prorating stays a manual HR call). */
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
    // F2.1 — a settled full-and-final froze the exit money; a NEW payslip
    // would add unconsidered payables after the fact. Refuse (the exit's
    // unprocessed-salary line was computed from the runs that existed).
    const settledFnF = await db.fullAndFinalStatement.findFirst({
      where: { userId: data.userId, status: "SETTLED" },
      select: { id: true },
    });
    if (settledFnF) {
      throw new AuthorizationError(
        "This employee's full-and-final statement is settled — no payslips can be added for them anymore.",
      );
    }
    // P10 — the run's REAL window (stored dates, falling back to the parsed
    // period key for pre-backfill rows) drives every per-slip derivation.
    // Phase 1B (G8): computed BEFORE the pay source is resolved, because the
    // assignment in force is dated by the window START.
    const runFrequency = (run.frequency || "MONTHLY") as PayrollFrequency;
    const windowStart = runWindowStart(run.period, run.startDate);
    const windowEnd = runWindowEnd(run.period, run.endDate);
    if (!windowStart || !windowEnd) {
      throw new AuthorizationError("The run's period is not a parseable payroll window — recreate the run.");
    }
    // Phase 1B (G8) — the assignment in force at the run's window start
    // decides which structure prices this joiner's slip; the assignment's
    // structure is authoritative even when retired — history pays from the
    // timeline, never from isActive. Hygiene (mirrors the createPayrollRun
    // guard): the legacy active-structure read is reserved for employees
    // whose timeline was NEVER materialised (zero SalaryStructureAssignment
    // rows of any date — never-backfilled workspaces). An employee with
    // rows but none in force at the window start (a future-dated first
    // assignment, the run predating the hire) is REFUSED — never paid from
    // the active structure for a pre-hire period.
    const assignment = await resolveAssignmentAt(db, data.userId, windowStart);
    let structure: SalaryStructure | null;
    if (assignment) {
      structure = await db.salaryStructure.findUnique({ where: { id: assignment.structureId } });
    } else {
      const anyAssignmentRows = await db.salaryStructureAssignment.findMany({
        where: { employeeId: data.userId },
        select: { id: true },
      });
      if (anyAssignmentRows.length > 0) {
        const joiner = await db.user.findUnique({
          where: { id: data.userId },
          select: { name: true },
        });
        throw new AuthorizationError(
          `No salary assignment in force for ${joiner?.name ?? data.userId} at ${windowStart.toISOString().slice(0, 10)} — cannot add payslip for this period`,
        );
      }
      structure = await db.salaryStructure.findFirst({
        where: { userId: data.userId, isActive: true },
      });
    }
    if (!structure) throw new AuthorizationError("No active salary structure for this employee — create one first.");
    // P10 — the joiner's structure cadence must match the run's (the same
    // frequency-matched rule run creation applies).
    if ((structure.frequency || "MONTHLY") !== runFrequency) {
      throw new AuthorizationError(
        `This employee's active structure is ${(structure.frequency || "MONTHLY").toLowerCase()} — it cannot join a ${runFrequency.toLowerCase()} run.`,
      );
    }
    // P8 — an ACTIVE hold covering the run's period stamps this joiner's
    // slip WITHHELD at birth (same rule as run creation).
    const activeHold = await db.salaryWithholding.findFirst({
      where: { userId: data.userId, status: "ACTIVE" },
      orderBy: { fromPeriod: "desc" },
    });
    const withheld = activeHold
      ? isPeriodHeld({ fromPeriod: activeHold.fromPeriod, untilPeriod: activeHold.untilPeriod }, run.period)
      : false;
    const count = await db.payslip.count({ where: { runId: run.id } });
    const components = parseComponents(structure.components);
    // F1.4 — same derivation as createPayrollRun, for this one joiner.
    const periodHolidays = await getHolidayLookup(windowStart, windowEnd);
    const lopByUser = await deriveLopDaysForUsers([data.userId], { start: windowStart, end: windowEnd }, periodHolidays);
    const facts = lopByUser.get(data.userId)
      ?? { lopDays: 0, paidDays: run.workingDays, clippedFrom: false, clippedUntil: false, lopDetail: null };
    const lopDays = facts.lopDays;
    // S7 — the rounding line lands last (auto-managed). P9 — the overtime
    // knob rides the same config read.
    const workspaceConfig = await getWorkspaceConfig();
    const roundingMode = workspaceConfig.workspace.payrollRoundingMode;
    const overtimePayEnabled = workspaceConfig.workspace.overtimePayEnabled;
    // P9 — this joiner's overtime minutes over the run's window (queried
    // only when the payout knob is on).
    const otMinutes = overtimePayEnabled
      ? (await db.attendanceRecord.findMany({
          where: {
            userId: data.userId,
            date: { gte: windowStart, lte: windowEnd },
            overtimeMinutes: { not: null },
          },
          select: { overtimeMinutes: true },
        })).reduce((s, r) => s + (r.overtimeMinutes ?? 0), 0)
      : 0;
    // P1 (F2.3) — this joiner's due adjustments ride the new slip (same
    // kernel + same transaction discipline as run creation). P10 — no
    // period-string pre-filter: the window-aware predicate decides due-ness.
    const pendingAdjustments = await db.payAdjustment.findMany({
      where: { status: "PENDING", userId: data.userId },
      orderBy: { createdAt: "asc" },
    });
    const due = pendingAdjustments.filter((row) => isDueInPeriod(row, run.period));
    // The one structure→lines derivation (scale → structure deductions →
    // overtime → LOP → the two-pass adjustment kernel); ordering rationale
    // lives in lib/payroll/slip-derivation.ts.
    const applied = deriveSlipLines({
      components,
      frequency: runFrequency,
      earningsYear: windowStart.getUTCFullYear(),
      workingDays: run.workingDays,
      paidDays: facts.paidDays,
      lopDays,
      periodKey: run.period,
      overtime: { enabled: overtimePayEnabled, minutes: otMinutes > 0 ? otMinutes : null },
      adapterRows: due,
    });
    // Phase 2 (engine wiring) — the joiner's statutory lines: priced on the
    // run's FROZEN rate set (run.rateSetId — "" = pre-engine run, none),
    // same pass as run creation. An engine refusal (broken STC certificate
    // etc.) FAILS LOUDLY: the joiner is one explicit employee, so blocking
    // with the engine's user-facing message beats creating an untaxed slip.
    let statutorySnapshot: Prisma.InputJsonValue | undefined;
    let autoEnrol: SlipAutoEnrolment | null = null;
    let statutoryPlan: SlipStatutoryPlan | null = null;
    let deductionsPreRounding = withoutStatutoryLines(applied.deductions);
    if (run.rateSetId && runFrequency !== "DAILY" && windowEnd) {
      const rateSet = await resolveNzRateSet(windowEnd, run.rateSetId);
      if (rateSet) {
        const [classification, profileRow] = await Promise.all([
          loadStatutoryClassification(),
          db.employeeTaxProfile.findUnique({ where: { userId: data.userId } }),
        ]);
        try {
          const plan = planSlipStatutory({
            userId: data.userId,
            frequency: runFrequency as NzPayFrequency,
            payPeriodEnd: windowEnd,
            rateSet,
            profileRow: (profileRow ?? null) as NzTaxProfileRow | null,
            earnings: applied.earnings,
            deductions: applied.deductions,
            classification,
          });
          statutorySnapshot = plan.snapshot as unknown as Prisma.InputJsonValue;
          autoEnrol = plan.autoEnrol;
          statutoryPlan = plan;
          deductionsPreRounding = persistStatutoryLines(applied.deductions, plan);
        } catch (e) {
          throw new AuthorizationError(
            `Statutory lines could not be computed for this employee — fix the tax profile first. ${e instanceof Error ? e.message : "Unknown statutory error"}`,
          );
        }
      }
      // A deleted rate set (OPEN-run edge) → no statutory lines; the audit
      // note below says so explicitly.
    }
    const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, deductionsPreRounding, roundingMode);
    const { gross, net } = payslipTotals(finalEarnings, deductions);
    const createData = {
      runId: run.id,
      userId: data.userId,
      earnings: JSON.stringify(finalEarnings),
      deductions: JSON.stringify(deductions),
      lopDays,
      lopSource: "AUTO",
      lopDetail: facts.lopDetail ? (facts.lopDetail as unknown as Prisma.InputJsonValue) : undefined,
      statutory: statutorySnapshot,
      ...statutorySnapshotColumns(statutoryPlan),
      paidDays: facts.paidDays,
      gross,
      net,
      withholdStatus: withheld ? "WITHHELD" : "",
    };
    // Phase 2 — the joiner's auto-enrolment lands with the slip (guarded,
    // in-transaction); audited after commit. Holder object: the assignment
    // happens inside the transaction closure, invisible to outer flow
    // analysis.
    const joinerEnrol: { value: { entry: SlipAutoEnrolment; slipNo: string } | null } = { value: null };
    const createSlipWithAdjustments = async (seq: number) =>
      db.$transaction(async (tx) => {
        const slip = await tx.payslip.create({ data: { ...createData, slipNo: slipNumber(run.period, seq) } });
        for (const c of applied.consumed) {
          const row = due.find((r) => r.id === c.id);
          if (!row) continue;
          await tx.payAdjustment.update({
            where: { id: row.id },
            data: {
              status: c.final ? "CONSUMED" : "PENDING",
              lastConsumedPeriod: run.period,
              consumedRunId: run.id,
            },
          });
        }
        for (const s of applied.skipped) {
          await tx.payAdjustment.update({ where: { id: s.id }, data: { status: "SKIPPED", skipReason: s.reason } });
        }
        if (autoEnrol && (await persistAutoEnrolment(tx, autoEnrol))) {
          joinerEnrol.value = { entry: autoEnrol, slipNo: slip.slipNo };
        }
        return slip;
      });
    let slip;
    try {
      slip = await createSlipWithAdjustments(count + 1);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Two HR users racing: recompute the sequence from the live count.
        const recount = await db.payslip.count({ where: { runId: run.id } });
        slip = await createSlipWithAdjustments(recount + 1);
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
      detail: `${auth.name} added payslip ${slip.slipNo} to the ${run.period} run${applied.consumed.length > 0 ? ` (${applied.consumed.length} adjustment(s) consumed)` : ""}${applied.otPayout ? ` — includes ${applied.otPayout.amount > 0 ? `overtime of $${applied.otPayout.amount.toLocaleString("en-NZ")}` : "overtime"}` : ""}${withheld ? " — WITHHELD under an active salary hold (net not disbursed until released)" : ""}.${statutorySnapshot ? ` Statutory lines computed (${JSON.parse(createData.deductions).filter((l: PayslipLine) => isStatutoryLineKey(l.key)).map((l: PayslipLine) => `${l.key} ${l.amount.toFixed(2)}`).join(", ")}).` : run.rateSetId ? " No statutory lines — the run's rate set is no longer available." : ""}`,
    });
    // Phase 2 — the joiner's enrolment audit entry (after commit).
    if (joinerEnrol.value) {
      await auditAutoEnrolments(auth, [{ ...joinerEnrol.value, period: run.period }]);
    }
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
    // P2 (LV-09, F2.2) — encashment rows whose money rode this run (the
    // adapter rows consumed by it) flip PAID with the run, in the same
    // transaction as the lock itself.
    const encashmentAdjustments = await db.payAdjustment.findMany({
      where: { consumedRunId: run.id, sourceType: "ENCASHMENT" },
      select: { sourceId: true },
    });
    const encashmentIds = encashmentAdjustments.map((a) => a.sourceId).filter((id) => id !== "");
    // P5 (PR-18, F3.2) — the benefits accrual inputs: every ACTIVE election
    // of an employee with a slip in this run accrues at lock (annual ÷ 12,
    // paid-days-scaled — the same window discipline as earnings).
    const benefitElections = await db.benefitElection.findMany({ where: { status: "ACTIVE" } });
    // P18 (PR-B16) — the payslip email knob (default OFF = the pre-P18
    // silence). When on, one PAYSLIP outbox row per slip rides the lock
    // transaction (no email without its lock), delivered best-effort
    // after it. HTML summary only — the mailer has no attachment support,
    // so the PDF itself stays the download-only decision §9.2.
    const emailPayslips = (await getWorkspaceConfig()).workspace.emailPayslipsOnLock === true;
    // Payslip carries no User relation (bare userId) — emails join in
    // memory, same as the P17 balance reads.
    const emailSlips = emailPayslips
      ? await (async () => {
          const rows = await db.payslip.findMany({
            where: { runId: run.id },
            select: {
              slipNo: true, userId: true, gross: true, net: true, lopDays: true,
              withholdStatus: true, deductions: true,
            },
          });
          const users = await db.user.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
            select: { id: true, name: true, email: true },
          });
          const userById = new Map(users.map((u) => [u.id, u]));
          return rows
            .map((r) => {
              const u = userById.get(r.userId);
              return u == null ? null : { ...r, user: { name: u.name, email: u.email } };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
        })()
      : [];
    const electionByUser = new Map<string, typeof benefitElections>();
    for (const e of benefitElections) {
      const list = electionByUser.get(e.userId);
      if (list) list.push(e);
      else electionByUser.set(e.userId, [e]);
    }
    // CI-repair — the lock transaction grew with every payroll phase (P2
    // encashment PAID flips, P5 accrual rows) and its audit MUST stay outside
    // the callback: logAudit writes on the GLOBAL client, so calling it
    // inside the interactive transaction opens a second connection that, on
    // SQLite, blocks on the transaction's own write lock — deadlock until
    // the 5s interactive-transaction timeout expires and the lock fails
    // ("Transaction already closed", the e2e "run did not render as LOCKED"
    // failure). The timeout itself is raised for the batch shape: one accrual
    // create per election per employee is a per-row round trip, which stays
    // comfortably under 5s at seeded volumes but deserves headroom at the
    // documented ≤200-employee scale on a remote Postgres (Supabase RTT).
    const accrualCount = { rows: 0 };
    // P18 — the queued email row ids (delivery happens after the tx).
    const emailRowIds: string[] = [];
    await db.$transaction(
      async (tx) => {
        await tx.payrollRun.update({
          where: { id: run.id },
          data: { status: "LOCKED", lockedById: auth.userId, lockedAt: new Date() },
        });
        if (encashmentIds.length > 0) {
          await tx.leaveEncashment.updateMany({
            where: { id: { in: encashmentIds }, status: "APPROVED" },
            data: { status: "PAID", paidRunId: run.id, paidAt: new Date() },
          });
        }
        // P5 — append-only ACCRUAL rows, one per election with a priced amount.
        const payslipRows = await tx.payslip.findMany({
          where: { runId: run.id },
          select: { userId: true, paidDays: true },
        });
        const paidDaysByUser = new Map(payslipRows.map((p) => [p.userId, p.paidDays]));
        for (const [userId, elections] of electionByUser) {
          if (!paidDaysByUser.has(userId)) continue;
          for (const e of elections) {
            const amount = accrualAmount({
              annualAmount: e.annualAmount,
              paidDays: paidDaysByUser.get(userId) ?? null,
              workingDays: run.workingDays,
            });
            if (amount <= 0) continue;
            await tx.benefitAccrual.create({
              data: {
                userId,
                year: e.year,
                componentCode: e.componentCode,
                entryType: "ACCRUAL",
                delta: amount,
                sourceId: run.id,
                period: run.period,
                note: `${e.label || e.componentCode} accrual (${run.period} lock)`,
              },
            });
            accrualCount.rows += 1;
          }
        }
        // P18 (PR-B16) — queue the payslip emails on the same transaction:
        // no email without its lock. Subjects carry no amounts (privacy);
        // the body is the plain-text audit copy the Outbox re-reads.
        for (const slip of emailSlips) {
          const row = await queueOutboxMail(tx, {
            kind: "PAYSLIP",
            toAddress: slip.user.email,
            subject: payslipEmailSubject(run.period),
            text: payslipEmailText(slip, run.period),
            sentById: auth.userId,
          });
          emailRowIds.push(row.id);
        }
      },
      { timeout: 30_000 },
    );
    // Phase 1C (G2) — post the locked run to the general ledger, AFTER the
    // lock commits (postPayrollRun re-reads the run; inside the interactive
    // transaction that read would race the SQLite write lock, and an
    // interactive-transaction JE create has the same second-connection
    // deadlock logAudit had). Best-effort at this seam: a missing
    // accounting period or an out-of-balance edge must not roll back a
    // payroll the business has already paid — the failure is audited and
    // the posting stays idempotent for a retry once the cause is fixed.
    let glPostedId: string | null = null;
    let glError: string | null = null;
    try {
      const je = await postPayrollRun(run.id, { postedById: auth.userId });
      glPostedId = je.id;
    } catch (e) {
      glError = e instanceof Error ? e.message : "unknown GL posting error";
    }
    if (glPostedId) {
      await logAudit({
        actor: auth,
        action: "payroll.gl_posted",
        entityType: "PAYROLL_RUN",
        entityId: run.id,
        entityLabel: run.period,
        detail: `${run.period} posted to the general ledger — journal entry ${glPostedId} (PAYROLL_RUN source, statutory liabilities + net pay clearing credited).`,
      });
    } else {
      await logAudit({
        actor: auth,
        action: "payroll.gl_posting_failed",
        entityType: "PAYROLL_RUN",
        entityId: run.id,
        entityLabel: run.period,
        detail: `${run.period} was NOT posted to the general ledger: ${glError}. Fix the cause and re-run the posting — it is idempotent.`,
      });
    }
    // P18 — deliver outside the transaction (provider I/O never holds the
    // lock and never throws into the business write — the S17 discipline;
    // one row at a time so a big run can't stampede the provider).
    const emailCounts = { sent: 0, skipped: 0, failed: 0 };
    if (emailRowIds.length > 0) {
      // Re-read only THIS lock's rows by id (a stale QUEUED row from a
      // crashed earlier delivery is never accidentally re-sent here).
      const queued = await db.mailOutbox.findMany({
        where: { id: { in: emailRowIds } },
        select: { id: true, toAddress: true, subject: true, body: true },
      });
      const rowById = new Map(queued.map((r) => [r.id, r]));
      for (const id of emailRowIds) {
        const row = rowById.get(id);
        if (!row) { emailCounts.failed += 1; continue; }
        const result = await deliverOutboxMail(row.id, {
          toAddress: row.toAddress,
          subject: row.subject,
          html: payslipEmailHtml(row.body),
          text: row.body,
        }).catch(() => undefined);
        if (!result) emailCounts.failed += 1;
        else emailCounts[result.status === "SENT" ? "sent" : result.status === "SKIPPED" ? "skipped" : "failed"] += 1;
      }
    }
    if (accrualCount.rows > 0) {
      await logAudit({
        actor: auth,
        action: "payroll.benefits_accrued",
        entityType: "PAYROLL_RUN",
        entityId: run.id,
        entityLabel: run.period,
        detail: `${run.period} lock accrued ${accrualCount.rows} benefit row(s) (elections ÷ 12, paid-days-scaled).`,
      });
    }
    const total = round2(run.payslips.reduce((s, p) => s + p.net, 0));
    await logAudit({
      actor: auth,
      action: "payroll.run_locked",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} locked the ${run.period} payroll run (paid) — ${run.payslips.length} payslips, net $${total.toLocaleString("en-NZ")}${encashmentIds.length > 0 ? `, ${encashmentIds.length} leave encashment(s) marked paid` : ""}${emailSlips.length > 0 ? `, ${emailSlips.length} payslip email(s) queued (${emailCounts.sent} sent, ${emailCounts.skipped} skipped, ${emailCounts.failed} failed)` : ""}.`,
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
