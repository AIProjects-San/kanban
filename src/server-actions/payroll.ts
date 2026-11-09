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
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import type { PayslipT, PayrollRunT, SalaryStructureT, PayAdjustmentT } from "@/lib/types";
import {
  saveSalaryStructureSchema,
  createPayrollRunSchema,
  updatePayslipSchema,
  lockPayrollRunSchema,
  addPayslipSchema,
  createPayAdjustmentSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseComponents, type OfferComponent } from "@/lib/offer-math";
import { workingDaysInPeriod, paymentWindow, type HolidayLookup } from "@/lib/working-days";
import { deriveLopDays, type LopAttendanceMark, type LopLeaveSpan } from "@/lib/lop-derivation";
import { getWorkspaceConfig } from "@/lib/config-loader";
import { getHolidayLookup } from "./hr-shared";
import {
  monthlyEarningsFromStructure,
  payslipTotals,
  scaleEarningsToPaidDays,
  lopBasisGross,
  withRoundingLine,
  withLopLine,
  daysInPeriod,
  parsePayslipLines,
  round2,
  type PayslipLine,
} from "@/lib/payroll-math";
// P1 (PR-12/PR-B10, F2.3) — the universal adjustment adapter kernel.
import {
  applyAdjustments,
  isDueInPeriod,
  validateAdjustmentInput,
  type PayAdjustmentRow,
} from "@/lib/pay-adjustment";
// P5 (PR-18, F3.2) — the benefits accrual pricing (lock hook).
import { accrualAmount } from "@/lib/benefits";
// P8 (PR-19/PR-B13, F3.3) — the salary-withholding hold-window predicate.
import { isPeriodHeld } from "@/lib/salary-withholding";
// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type StructureRow = {
  id: string; userId: string; components: string; notes: string;
  effectiveFrom: Date; isActive: boolean; createdAt: Date;
  maxBenefits?: number | null;
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
    maxBenefits: s.maxBenefits ?? 0,
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
      // P5 — the flexible-benefit cap rides the structure (0 = no cap).
      ...(data.maxBenefits !== undefined ? { maxBenefits: data.maxBenefits } : {}),
    };
    let row: { id: string };
    if (data.id) {
      row = await db.salaryStructure.update({ where: { id: data.id }, data: payload });
    } else {
      // One ACTIVE structure per employee: retire the previous one.
      // F-R1: retire + create in ONE transaction — two separate writes could
      // leave an employee with zero ACTIVE structures between them (silently
      // dropping them from every future run). The transaction makes the
      // hand-off atomic: either the new row exists and the old one is
      // retired, or neither happened.
      row = await db.$transaction(async (tx) => {
        await tx.salaryStructure.updateMany({
          where: { userId: data.userId, isActive: true },
          data: { isActive: false },
        });
        return tx.salaryStructure.create({ data: payload });
      });
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

    // F1.5 — map the offer's lines through the component catalog: for codes
    // the catalog knows, the structure line takes the catalog's canonical
    // label/kind/mode (the offer snapshot keeps its own copy verbatim — the
    // appointment letter never rewrites); the AMOUNT always stays the offer's
    // actual, never the catalog's suggestion. Codes the catalog has never
    // seen are auto-registered (with the offer's sighting as the suggested
    // amount) so the catalog converges on everything actually in use — the
    // structure editor's picker then offers them next time.
    const catalogRows = await db.salaryComponent.findMany({
      select: { code: true, label: true, kind: true, mode: true, dependsOnPaymentDays: true },
    });
    const catalogByCode = new Map(catalogRows.map((r) => [r.code, r]));
    const toRegister = components.filter((c) => !catalogByCode.has(c.key));
    const mapped = components.map((c) => {
      const cat = catalogByCode.get(c.key);
      // S6 — the catalog's depends_on_payment_days rides the snapshot
      // (sparse: only false is written into the JSON).
      return cat
        ? {
            ...c,
            label: cat.label,
            kind: cat.kind as OfferComponent["kind"],
            mode: cat.mode as OfferComponent["mode"],
            ...(cat.dependsOnPaymentDays === false ? { dependsOnPaymentDays: false } : { dependsOnPaymentDays: undefined }),
          }
        : c;
    });

    // F-R1: retire + create (+ F1.5 auto-registration of unseen codes) in
    // ONE transaction — a crash between the writes could otherwise leave the
    // employee with zero ACTIVE structures, silently dropping them from
    // every future run.
    const row = await db.$transaction(async (tx) => {
      for (const c of toRegister) {
        await tx.salaryComponent.create({
          data: {
            code: c.key,
            label: c.label,
            kind: c.kind,
            mode: c.mode,
            defaultAmount: c.amount,
            // S6 — offer lines carry no exemption knowledge; new codes
            // register as payment-day scaled (the default knob).
            dependsOnPaymentDays: true,
            isActive: true,
            sortOrder: 1000,
          },
        });
      }
      await tx.salaryStructure.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });
      return tx.salaryStructure.create({
        data: {
          userId,
          components: JSON.stringify(mapped),
          notes: `Copied from the signed offer (${offer.templateLabel || "custom"}).`,
          isActive: true,
          createdById: auth.userId,
        },
      });
    });
    await logAudit({
      actor: auth,
      action: "payroll.structure_from_offer",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} copied ${candidate.fullName}'s signed offer (${offer.templateLabel || "custom"}) into a salary structure${toRegister.length > 0 ? `, auto-registering ${toRegister.length} new component code(s): ${toRegister.map((c) => c.key).join(", ")}` : ""}.`,
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

// ---------------------------------------------------------------------------
// F1.4 — attendance→LOP derivation fetch
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1)
// ---------------------------------------------------------------------------

/** Per-user loss-of-pay days for a period, derived from attendance marks
 * (ABSENT / HALF_DAY) and approved leave (paid types shield the day, unpaid
 * types charge it — lib/lop-derivation.ts has the exact per-day semantics).
 * Charges only working days (weekends/holidays never charge); days with no
 * record and no leave charge 0 (unless PR-B07's ABSENT mode). Runs at
 * run/slip CREATION only — the value is then a snapshot on the payslip
 * (F1.1's never-re-derived discipline).
 * S5 (PR-B06) — also returns each user's PAID DAYS (the employment-window
 * working-day count from lib/working-days.ts paymentWindow) so the caller
 * can scale earnings to the days actually employed. */
interface PayrollFacts {
  lopDays: number;
  paidDays: number;
  clippedFrom: boolean;
  clippedUntil: boolean;
}

async function deriveLopDaysForUsers(
  userIds: string[],
  period: string,
  holidays: HolidayLookup,
): Promise<Map<string, PayrollFacts>> {
  // PR-B07 (S4) — the workspace's unmarked-day policy rides every
  // derivation (IGNORED default = pre-S4 semantics byte-for-byte).
  const config = await getWorkspaceConfig();
  const unmarkedMode = config.workspace.unmarkedAttendanceMode;
  const result = new Map<string, PayrollFacts>();
  if (userIds.length === 0) return result;
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return result;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));

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

  // Paid flag per leave type. A missing type row (deleted type) defaults to
  // paid — never dock pay off missing master data.
  const typeIds = [...new Set(leaveRows.map((r) => r.leaveTypeId))];
  const types = typeIds.length > 0
    ? await db.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, paid: true } })
    : [];
  const paidByType = new Map(types.map((t) => [t.id, t.paid]));

  const byUser = new Map<string, { marks: LopAttendanceMark[]; spans: LopLeaveSpan[]; opts: { unmarkedMode: "IGNORED" | "ABSENT"; employmentFrom: Date | null; employmentUntil: Date | null } }>();
  for (const u of userIds) byUser.set(u, { marks: [], spans: [], opts: { unmarkedMode, employmentFrom: null, employmentUntil: null } });
  for (const mk of marks) byUser.get(mk.userId)?.marks.push({ date: mk.date, status: mk.status });
  for (const lr of leaveRows) {
    byUser.get(lr.userId)?.spans.push({
      startDate: lr.startDate,
      endDate: lr.endDate,
      paid: paidByType.get(lr.leaveTypeId) ?? true,
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
    // uses (one read, one truth): working days in [hireDate, LWD] ∩ period.
    const win = paymentWindow(period, holidays, { from: opts.employmentFrom, until: opts.employmentUntil });
    result.set(u, {
      lopDays: deriveLopDays(period, holidays, userMarks, spans, opts),
      paidDays: win.paidDays,
      clippedFrom: win.clippedFrom,
      clippedUntil: win.clippedUntil,
    });
  }
  return result;
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
      workingDays: r.workingDays,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/** Create a monthly run and snapshot every ACTIVE structure into payslips
 * (monthly = annual ÷ 12). One run per period (unique). F1.4: each slip's
 * loss-of-pay days are pre-derived from attendance + unpaid leave
 * (lopSource AUTO) and the LOP deduction line is materialized at creation. */
export async function createPayrollRun(input: unknown): Promise<ActionResult<{ id: string; payslipCount: number; adjustmentsApplied: number; adjustmentsSkipped: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createPayrollRunSchema, input);
    const existing = await db.payrollRun.findUnique({ where: { period: data.period }, select: { id: true } });
    if (existing) throw new AuthorizationError(`A run for ${data.period} already exists.`);

    const structures = await db.salaryStructure.findMany({ where: { isActive: true } });
    if (structures.length === 0) {
      throw new AuthorizationError("No active salary structures — create at least one before running payroll.");
    }

    // F1.1 — the run's holiday-aware LOP denominator, denormalized at
    // creation and never re-derived: Mon–Fri days of the period minus
    // holiday-calendar entries (half-days 0.5). An empty calendar yields the
    // plain Mon–Fri count — only PRE-F1.1 rows carry 0, and readers fall
    // back to the calendar month length for those (daysInPeriod).
    const [y, m] = data.period.split("-").map(Number);
    const periodHolidays = await getHolidayLookup(
      new Date(Date.UTC(y, m - 1, 1)),
      new Date(Date.UTC(y, m, 0)),
    );
    const runWorkingDays = workingDaysInPeriod(data.period, periodHolidays);
    // S7 (PR-B23) — the workspace rounding policy rides run creation
    // (snapshot: flips affect future runs, never stored slips).
    const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;

    // F1.4 — derive each payslip's loss-of-pay days from attendance marks
    // (ABSENT / HALF_DAY) + unpaid approved leave, charged only on working
    // days of the period. Snapshot semantics: the value is written once at
    // creation (lopSource AUTO); corrections afterwards go through a manual
    // HR override in updatePayslip, never a silent re-derivation.
    // S5 (PR-B06) — the same facts carry each employee's PAID DAYS (the
    // employment-window working-day count); earnings scale by
    // paidDays / workingDays so mid-month joiners/leavers are paid for the
    // days they were employed (deliberate default-ON correctness fix;
    // pre-S5 rows read as full-period).
    const lopByUser = await deriveLopDaysForUsers(
      structures.map((s) => s.userId),
      data.period,
      periodHolidays,
    );
    const autoLopCount = [...lopByUser.values()].filter((f) => f.lopDays > 0).length;
    const clippedCount = [...lopByUser.values()].filter((f) => f.clippedFrom || f.clippedUntil).length;

    // P1 (PR-12/PR-B10, F2.3) — the adjustment adapter consumption: every
    // PENDING row due in this period resolves onto its employee's payslip
    // through the pure two-pass kernel, and the row updates commit in the
    // SAME transaction as the run (a consumed row without its money, or
    // money without its row, is impossible — the S17 discipline).
    const pendingAdjustments = await db.payAdjustment.findMany({
      where: { status: "PENDING", period: { lte: data.period } },
      orderBy: { createdAt: "asc" },
    });
    const dueByUser = new Map<string, PayAdjustmentRow[]>();
    for (const row of pendingAdjustments) {
      if (!isDueInPeriod(row, data.period)) continue;
      const list = dueByUser.get(row.userId);
      if (list) list.push(row);
      else dueByUser.set(row.userId, [row]);
    }
    const slipUserIds = new Set(structures.map((s) => s.userId));
    // Due rows whose employee has no slip in this run: ONE_SHOT/OVERWRITE
    // periods never come back, so they are SKIPPED with a visible reason;
    // RECURRING rows stay PENDING (a future run may yet include them).
    const noSlipSkips = pendingAdjustments.filter(
      (row) => isDueInPeriod(row, data.period) && !slipUserIds.has(row.userId) && row.recurrence !== "RECURRING",
    );
    type ConsumedEntry = { row: PayAdjustmentRow; final: boolean };
    const consumedEntries: ConsumedEntry[] = [];
    const kernelSkips: Array<{ id: string; reason: string }> = [];

    // P8 (PR-19/PR-B13, F3.3) — ACTIVE hold windows stamp their slips
    // WITHHELD at birth: the slip is computed and frozen normally, but its
    // net is not disbursed (YTD/self-service exclude it) until the hold is
    // released — the release pays through the adapter, never the slip.
    const activeWithholdings = await db.salaryWithholding.findMany({ where: { status: "ACTIVE" } });
    const heldUserIds = new Set(
      activeWithholdings
        .filter((w) => isPeriodHeld({ fromPeriod: w.fromPeriod, untilPeriod: w.untilPeriod }, data.period))
        .map((w) => w.userId),
    );

    const run = await db.$transaction(async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          period: data.period,
          status: "OPEN",
          createdById: auth.userId,
          workingDays: runWorkingDays,
          payslips: {
            create: structures.map((s, i) => {
              const facts = lopByUser.get(s.userId)
                ?? { lopDays: 0, paidDays: runWorkingDays, clippedFrom: false, clippedUntil: false };
              const earnings = scaleEarningsToPaidDays(
                monthlyEarningsFromStructure(parseComponents(s.components)),
                facts.paidDays,
                runWorkingDays,
              );
              const lopDays = facts.lopDays;
              // The auto LOP line is materialized at creation (net totals are
              // honest immediately — no per-slip save needed to see the dock).
              // S6 — the LOP basis excludes window-exempt lines (a flat
              // allowance is not reduced by absent days).
              const lopDeductions = lopDays > 0
                ? withLopLine([], lopBasisGross(earnings), lopDays, data.period, runWorkingDays > 0 ? runWorkingDays : undefined)
                : [];
              // P1 — adjustments land on the docked base (post scaling,
              // post LOP), the rounding line wraps the final net.
              const applied = applyAdjustments(
                { earnings, deductions: lopDeductions },
                dueByUser.get(s.userId) ?? [],
                data.period,
              );
              for (const c of applied.consumed) {
                const row = (dueByUser.get(s.userId) ?? []).find((r) => r.id === c.id);
                if (row) consumedEntries.push({ row, final: c.final });
              }
              kernelSkips.push(...applied.skipped);
              const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, roundingMode);
              const { gross, net } = payslipTotals(finalEarnings, deductions);
              return {
                userId: s.userId,
                slipNo: slipNumber(data.period, i + 1),
                earnings: JSON.stringify(finalEarnings),
                deductions: JSON.stringify(deductions),
                lopDays,
                lopSource: "AUTO",
                paidDays: facts.paidDays,
                gross,
                net,
                withholdStatus: heldUserIds.has(s.userId) ? "WITHHELD" : "",
              };
            }),
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
            lastConsumedPeriod: data.period,
            consumedRunId: created.id,
          },
        });
      }
      const skipById = new Map<string, string>();
      for (const s of kernelSkips) skipById.set(s.id, s.reason);
      for (const row of noSlipSkips) skipById.set(row.id, `no payslip for the employee in the ${data.period} run`);
      for (const [id, reason] of skipById) {
        await tx.payAdjustment.update({ where: { id }, data: { status: "SKIPPED", skipReason: reason } });
      }
      return created;
    });

    const adjustmentsApplied = consumedEntries.length;
    const adjustmentsSkipped = new Set([...kernelSkips.map((s) => s.id), ...noSlipSkips.map((r) => r.id)]).size;

    await logAudit({
      actor: auth,
      action: "payroll.run_created",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} created the ${run.period} payroll run with ${run.payslips.length} payslips from the active salary structures${autoLopCount > 0 ? ` (${autoLopCount} with auto-derived loss-of-pay from attendance and unpaid leave)` : ""}${clippedCount > 0 ? ` (${clippedCount} scaled to mid-period employment windows)` : ""}${heldUserIds.size > 0 ? ` (${heldUserIds.size} payslip(s) WITHHELD under an active salary hold)` : ""}${adjustmentsApplied > 0 || adjustmentsSkipped > 0 ? ` (${adjustmentsApplied} adjustment(s) consumed${adjustmentsSkipped > 0 ? `, ${adjustmentsSkipped} skipped with reason` : ""})` : ""}`,
    });
    revalidatePath("/");
    return { id: run.id, payslipCount: run.payslips.length, adjustmentsApplied, adjustmentsSkipped };
  });
}

/** One run's payslips with names + YTD net (same-year periods up to and
 * including this run — OPEN periods count so the current month is live). */
export async function getPayrollRun(
  runId: string,
): Promise<ActionResult<{ run: PayrollRunT; payslips: PayslipT[]; unmarkedMode: "IGNORED" | "ABSENT"; roundingMode: "ROUND_2DP" | "ROUND_NET_NEAREST" }>> {
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
    // P8 — WITHHELD/RELEASED slips never count: a held net is not paid, and
    // a released one already paid through its WITHHELD_RELEASE adjustment
    // (money counts exactly once, in the release period's slip).
    const yearRuns = await db.payrollRun.findMany({
      where: { period: { startsWith: year } },
      select: { id: true, period: true },
    });
    const runIdsUpTo = yearRuns.filter((r) => r.period <= run.period).map((r) => r.id);
    const yearSlips = await db.payslip.findMany({
      where: { runId: { in: runIdsUpTo }, withholdStatus: "" },
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
        version: p.version,
        paidDays: p.paidDays ?? null,
        gross: p.gross,
        net: p.net,
        ytdNet: ytdByUser.get(p.userId) ?? p.net,
        withholdStatus: (p.withholdStatus === "WITHHELD" || p.withholdStatus === "RELEASED" ? p.withholdStatus : "") as "" | "WITHHELD" | "RELEASED",
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
        workingDays: run.workingDays,
        createdAt: run.createdAt.toISOString(),
      },
      payslips,
      // PR-B07 (S4) + PR-B23 (S7) — the CURRENT workspace policies for the
      // modal's honesty note + live preview (the derivation itself is a
      // creation-time snapshot).
      unmarkedMode: (await getWorkspaceConfig()).workspace.unmarkedAttendanceMode,
      roundingMode: (await getWorkspaceConfig()).workspace.payrollRoundingMode,
    };
  });
}

/** Edit one payslip's lines while the run is OPEN. The LOP deduction line is
 * auto-managed from lopDays (gross × days / days-in-period); manual
 * deduction lines are kept as entered. gross/net recomputed server-side.
 * F1.4: changing lopDays flips lopSource to MANUAL (an audited override of
 * the run-creation derivation); saving the same value keeps the provenance. */
export async function updatePayslip(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(updatePayslipSchema, input);
    const slip = await db.payslip.findUnique({
      where: { id: data.payslipId },
      include: { run: { select: { id: true, period: true, status: true, workingDays: true } } },
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
    const grossBefore = slip.gross;
    const netBefore = slip.net;
    // S6 — the LOP basis excludes window-exempt lines (flags ride the
    // submitted lines' snapshots).
    const lopDeductions = withLopLine(data.deductions, lopBasisGross(data.earnings), lopDays, slip.run.period, runWorkingDays > 0 ? runWorkingDays : undefined);
    // S8 — statistical lines are display-only and never editable: the
    // stored snapshot's statistical rows ride along untouched (the editor
    // never submits them).
    const statisticalLines = parsePayslipLines(slip.earnings).filter((l) => l.statistical);
    const submittedEarnings = data.earnings.filter((l) => !l.statistical);
    // S7 — the rounding line is auto-managed on save too (replaced, never
    // duplicated); the editor never submits it.
    const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;
    const { earnings: finalEarnings, deductions } = withRoundingLine([...submittedEarnings, ...statisticalLines], lopDeductions, roundingMode);
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
        note: data.note,
        gross,
        net,
        version: slip.version + 1,
      },
    });
    await logAudit({
      actor: auth,
      action: "payroll.payslip_updated",
      entityType: "PAYSLIP",
      entityId: slip.id,
      entityLabel: slip.slipNo,
      detail: `${auth.name} updated payslip ${slip.slipNo}${lopDays > 0 ? ` (LOP ${lopDays} day${lopDays === 1 ? "" : "s"}${lopDaysChanged ? `, manually set — the ${slip.lopSource === "MANUAL" ? "previous" : "auto-derived"} value was ${slip.lopDays} day${slip.lopDays === 1 ? "" : "s"}` : ""})` : ""}: gross ${grossBefore.toFixed(2)} → ${gross.toFixed(2)}, net ${netBefore.toFixed(2)} → ${net.toFixed(2)}.`,
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
    const structure = await db.salaryStructure.findFirst({
      where: { userId: data.userId, isActive: true },
    });
    if (!structure) throw new AuthorizationError("No active salary structure for this employee — create one first.");
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
    const earnings = monthlyEarningsFromStructure(parseComponents(structure.components));
    // F1.4 — same derivation as createPayrollRun, for this one joiner.
    const [py, pm] = run.period.split("-").map(Number);
    const periodHolidays = await getHolidayLookup(
      new Date(Date.UTC(py, pm - 1, 1)),
      new Date(Date.UTC(py, pm, 0)),
    );
    const lopByUser = await deriveLopDaysForUsers([data.userId], run.period, periodHolidays);
    const facts = lopByUser.get(data.userId)
      ?? { lopDays: 0, paidDays: run.workingDays, clippedFrom: false, clippedUntil: false };
    const lopDays = facts.lopDays;
    // S5 (PR-B06) — the joiner's earnings scale to their employment window:
    // pre-join days are no longer a manual HR LOP call, the run snapshots
    // the pro-rated lines (and paidDays) directly.
    const scaledEarnings = scaleEarningsToPaidDays(
      earnings,
      facts.paidDays,
      run.workingDays > 0 ? run.workingDays : undefined,
    );
    // S6 — the LOP basis excludes window-exempt lines.
    const lopDeductions = lopDays > 0
      ? withLopLine([], lopBasisGross(scaledEarnings), lopDays, run.period, run.workingDays > 0 ? run.workingDays : undefined)
      : [];
    // S7 — the rounding line lands last (auto-managed).
    const roundingMode = (await getWorkspaceConfig()).workspace.payrollRoundingMode;
    // P1 (F2.3) — this joiner's due adjustments ride the new slip (same
    // kernel + same transaction discipline as run creation).
    const pendingAdjustments = await db.payAdjustment.findMany({
      where: { status: "PENDING", period: { lte: run.period }, userId: data.userId },
      orderBy: { createdAt: "asc" },
    });
    const due = pendingAdjustments.filter((row) => isDueInPeriod(row, run.period));
    const applied = applyAdjustments({ earnings: scaledEarnings, deductions: lopDeductions }, due, run.period);
    const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, roundingMode);
    const { gross, net } = payslipTotals(finalEarnings, deductions);
    const createData = {
      runId: run.id,
      userId: data.userId,
      earnings: JSON.stringify(finalEarnings),
      deductions: JSON.stringify(deductions),
      lopDays,
      lopSource: "AUTO",
      paidDays: facts.paidDays,
      gross,
      net,
      withholdStatus: withheld ? "WITHHELD" : "",
    };
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
      detail: `${auth.name} added payslip ${slip.slipNo} to the ${run.period} run${applied.consumed.length > 0 ? ` (${applied.consumed.length} adjustment(s) consumed)` : ""}${withheld ? " — WITHHELD under an active salary hold (net not disbursed until released)" : ""}.`,
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
    const electionByUser = new Map<string, typeof benefitElections>();
    for (const e of benefitElections) {
      const list = electionByUser.get(e.userId);
      if (list) list.push(e);
      else electionByUser.set(e.userId, [e]);
    }
    await db.$transaction(async (tx) => {
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
      const accrualCount = { rows: 0 };
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
    });
    const total = Math.round(run.payslips.reduce((s, p) => s + p.net, 0) * 100) / 100;
    await logAudit({
      actor: auth,
      action: "payroll.run_locked",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `${auth.name} locked the ${run.period} payroll run (paid) — ${run.payslips.length} payslips, net $${total.toLocaleString("en-NZ")}${encashmentIds.length > 0 ? `, ${encashmentIds.length} leave encashment(s) marked paid` : ""}.`,
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
    const [slips, profile] = await Promise.all([
      db.payslip.findMany({
        where: { userId: auth.userId, run: { status: "LOCKED" } },
        include: { run: { select: { period: true, workingDays: true } } },
      }),
      db.employeeProfile.findUnique({
        where: { userId: auth.userId },
        select: { jobTitle: true },
      }),
    ]);

    // Running YTD per calendar year over the locked-only basis (ascending
    // period order; slipNo breaks ties, though a user has one slip per run).
    // P8 — WITHHELD/RELEASED slips never add to YTD: a held net is not paid,
    // and a released one pays through its adjustment in the release period
    // (the money counts exactly once, there).
    const runningByYear = new Map<string, number>();
    const ytdBySlip = new Map<string, number>();
    for (const s of [...slips].sort((a, b) => a.run.period.localeCompare(b.run.period) || a.slipNo.localeCompare(b.slipNo))) {
      const year = s.run.period.slice(0, 4);
      if (s.withholdStatus === "WITHHELD" || s.withholdStatus === "RELEASED") {
        ytdBySlip.set(s.id, runningByYear.get(year) ?? 0); // held/released: YTD carries the last paid value
        continue;
      }
      const acc = Math.round(((runningByYear.get(year) ?? 0) + s.net) * 100) / 100;
      runningByYear.set(year, acc);
      ytdBySlip.set(s.id, acc);
    }

    return [...slips]
      .sort((a, b) => b.run.period.localeCompare(a.run.period) || a.slipNo.localeCompare(b.slipNo))
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
        version: p.version,
        paidDays: p.paidDays ?? null,
        gross: p.gross,
        net: p.net,
        ytdNet: ytdBySlip.get(p.id) ?? p.net,
        withholdStatus: (p.withholdStatus === "WITHHELD" || p.withholdStatus === "RELEASED" ? p.withholdStatus : "") as "" | "WITHHELD" | "RELEASED",
      }));
  });
}

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
      where: { status: "PENDING", period: { lte: run.period } },
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
