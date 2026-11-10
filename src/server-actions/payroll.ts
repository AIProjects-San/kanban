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
import { Prisma } from "@prisma/client";
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import type { PayslipT, PayrollRunT, SalaryStructureT, PayAdjustmentT, LopDetailT, OpeningYtdRowT } from "@/lib/types";
import {
  saveSalaryStructureSchema,
  createPayrollRunSchema,
  bulkAssignStructureSchema,
  updatePayslipSchema,
  lockPayrollRunSchema,
  exportPayrollCsvSchema,
  addPayslipSchema,
  createPayAdjustmentSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit, queueOutboxMail, deliverOutboxMail } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseComponents, type OfferComponent } from "@/lib/offer-math";
import { workingDaysBetween, paymentWindowBetween, type HolidayLookup } from "@/lib/working-days";
import { deriveLopBreakdownBetween, type LopAttendanceMark, type LopLeaveSpan } from "@/lib/lop-derivation";
import { getWorkspaceConfig } from "@/lib/config-loader";
import { getHolidayLookup } from "./hr-shared";
import { payslipEmailSubject, payslipEmailText, payslipEmailHtml } from "@/lib/payslip-email";
import { salaryRegisterCsv, bankRemittanceCsv } from "@/lib/payroll-csv";
import {
  windowEarningsFromStructure,
  windowDeductionsFromStructure,
  payslipTotals,
  scaleEarningsToPaidDays,
  lopBasisGross,
  withRoundingLine,
  withLopLine,
  daysInPeriod,
  lineSum,
  parsePayslipLines,
  round2,
  type PayslipLine,
} from "@/lib/payroll-math";
// P1 (PR-12/PR-B10, F2.3) — the universal adjustment adapter kernel.
import {
  applyAdjustments,
  isDueInPeriod,
  structureNetDeductionRows,
  validateAdjustmentInput,
  type PayAdjustmentRow,
} from "@/lib/pay-adjustment";
// P5 (PR-18, F3.2) — the benefits accrual pricing (lock hook).
import { accrualAmount } from "@/lib/benefits";
// P8 (PR-19/PR-B13, F3.3) — the salary-withholding hold-window predicate.
import { isPeriodHeld } from "@/lib/salary-withholding";
// P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge kernel.
import {
  OVERTIME_LINE_KEY,
  overtimeLineLabel,
  planOvertimePayout,
  sumOvertimeMinutes,
} from "@/lib/overtime-bridge";
// P10 (PR-B05) — the payroll-windows kernel: every cadence resolves to ONE
// window {start, end, periodKey}; period-string comparisons became window
// comparisons so mixed cadences stay chronological.
import {
  resolvePayrollWindow,
  runWindowEnd,
  runWindowStart,
  fiscalYearOf,
  type PayrollFrequency,
} from "@/lib/payroll-windows";
// P11 (PR-B09) — read-time payslip aggregates (YTD gross/net, MTD net,
// per-component YTD) — ONE kernel for both the HR and self-service reads.
// P16 (PR-11) — the kernel now also takes the fiscal-year basis + the SSA
// opening entries (both default to the pre-P16 behavior).
import {
  computeRunningAggregates,
  type OpeningYtdEntry,
} from "@/lib/payslip-aggregates";
// P22 (PR-C01–04, PR-N01–06) — the pure analytics kernel behind the Payroll
// view's charts + cards panel.
import { buildPayrollAnalytics, type PayrollAnalytics } from "@/lib/payroll-analytics";
// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type StructureRow = {
  id: string; userId: string; components: string; notes: string;
  effectiveFrom: Date; isActive: boolean; createdAt: Date;
  maxBenefits?: number | null;
  frequency?: string | null;
  openingYtd?: unknown;
  isDefault?: boolean | null;
};

/** P16 (PR-04) — parse a structure's stored opening rows defensively
 * (null / malformed → null; the write path guarantees the shape). */
function parseOpeningYtd(raw: unknown): OpeningYtdRowT[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const rows = raw.filter(
      (r): r is OpeningYtdRowT =>
        !!r && typeof r === "object" &&
        typeof (r as { key?: unknown }).key === "string" && (r as { key: string }).key.length > 0 &&
        ((r as { side?: unknown }).side === "EARNING" || (r as { side?: unknown }).side === "DEDUCTION") &&
        Number.isFinite((r as { amount?: unknown }).amount),
    );
    if (rows.length === 0) return null;
    return rows.map((r) => ({
      key: r.key,
      label: typeof r.label === "string" ? r.label : r.key,
      side: r.side,
      amount: Math.max(0, Number(r.amount) || 0),
    }));
  }
  return null;
}

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
    frequency: (s.frequency || "MONTHLY") as SalaryStructureT["frequency"],
    // P16 — the SSA opening YTD rows (null = none).
    openingYtd: parseOpeningYtd(s.openingYtd),
    // P23 — the workspace default package flag (pre-P23 rows read false).
    isDefault: s.isDefault ?? false,
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

/** P16 (PR-04) — the SSA opening entries for the aggregate kernel: every
 * structure (active OR retired — an opening is a fact of what was earned)
 * whose parsed opening rows exist and whose effectiveFrom falls in a fiscal
 * year ANY of the given users has (or will have) a slip in. The entry's
 * fiscalStartYear is resolved through the SAME fiscalYearOf the kernel uses,
 * so basis flips re-attribute openings consistently on the next read. */
async function openingEntriesForUsers(
  userIds: string[],
  fiscalYearStartMonth: number,
): Promise<OpeningYtdEntry[]> {
  if (userIds.length === 0) return [];
  const structures = await db.salaryStructure.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, effectiveFrom: true, openingYtd: true },
  });
  const out: OpeningYtdEntry[] = [];
  for (const s of structures) {
    const rows = parseOpeningYtd(s.openingYtd);
    if (!rows) continue;
    out.push({
      userId: s.userId,
      fiscalStartYear: fiscalYearOf(s.effectiveFrom.getTime(), fiscalYearStartMonth),
      components: rows.map((r) => ({
        key: r.key,
        label: r.label || r.key,
        side: r.side,
        amount: r.amount,
      })),
    });
  }
  return out;
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
    const effectiveFrom = data.effectiveFrom
      ? new Date(`${data.effectiveFrom}T00:00:00Z`)
      : new Date();
    const effectiveDay = effectiveFrom.toISOString().slice(0, 10);

    // P16 (PR-04 duplicate guard) — one structure per employee per effective
    // date (the benchmark's SSA duplicate guard; the retire-on-revision
    // discipline already guarantees one ACTIVE, this refuses a SECOND row
    // for the same day — a revision must move the date forward, history
    // must stay addressable by date). Updates keep their own day.
    const sameDay = await db.salaryStructure.findFirst({
      where: { userId: data.userId, effectiveFrom: { gte: effectiveFrom, lt: new Date(`${effectiveDay}T23:59:59.999Z`) } },
      select: { id: true },
    });
    if (sameDay && sameDay.id !== data.id) {
      throw new AuthorizationError(
        `${user.name} already has a structure effective ${effectiveDay} — revise it or pick another effective date.`,
      );
    }

    // P16 (PR-11 component effective windows) — a structure's lines must be
    // valid ON the structure's effectiveFrom (the catalog row owns the
    // window; structures keep snapshot copies, so this check bites only at
    // write time for the NEW row). Friendly error names the row + window.
    const catalogRows = await db.salaryComponent.findMany({
      select: { code: true, effectiveFrom: true, effectiveTo: true },
    });
    const windowByCode = new Map(catalogRows.map((r) => [r.code, r]));
    for (const c of data.components) {
      const cat = windowByCode.get(c.key);
      if (!cat) continue; // unseen codes auto-register unbounded at creation
      const fromOk = !cat.effectiveFrom || cat.effectiveFrom.getTime() <= effectiveFrom.getTime();
      const toOk = !cat.effectiveTo || effectiveFrom.getTime() <= cat.effectiveTo.getTime();
      if (!fromOk || !toOk) {
        throw new AuthorizationError(
          `Component "${c.key}" is not in its catalog window (${cat.effectiveFrom ? cat.effectiveFrom.toISOString().slice(0, 10) : "—"} → ${cat.effectiveTo ? cat.effectiveTo.toISOString().slice(0, 10) : "—"}) at the structure's effective date ${effectiveDay}.`,
        );
      }
    }

    const payload = {
      userId: data.userId,
      components: JSON.stringify(data.components),
      notes: data.notes,
      effectiveFrom,
      isActive: true,
      createdById: auth.userId,
      // P5 — the flexible-benefit cap rides the structure (0 = no cap).
      ...(data.maxBenefits !== undefined ? { maxBenefits: data.maxBenefits } : {}),
      // P10 — the cadence this structure pays on (default MONTHLY).
      frequency: data.frequency,
      // P23 (PR-03) — the workspace default package flag; the wire omits
      // it to keep the stored value (the maxBenefits convention), so it is
      // only written when the caller sends it.
      ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
      // P16 (PR-04) — the opening YTD rows. Absent = the key is omitted
      // entirely (update keeps the stored rows, create stores none); an
      // explicitly emptied list clears the column (DbNull — the same
      // discipline updatePayslip uses to clear lopDetail).
      ...(data.openingYtd !== undefined
        ? {
            openingYtd:
              data.openingYtd && data.openingYtd.length > 0
                ? (data.openingYtd as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
          }
        : {}),
    };
    // P23 — at most ONE default package per workspace: saving this row as
    // the default clears every other holder. The clear + write must be ONE
    // transaction (a crash between them could leave two defaults — the
    // F-R1 discipline). Retirement of the old default is NOT automatic: a
    // retired default still prefills (the flag is a package pointer, not
    // employment state); HR moves it by marking the new structure.
    const clearOtherDefaults =
      data.isDefault === true
        ? { isDefault: true as const, ...(data.id ? { id: { not: data.id } } : {}) }
        : null;
    let row: { id: string };
    if (data.id) {
      // openingYtd is absent from payload when the wire omitted it → the
      // column stays untouched (Prisma only writes given keys).
      row = clearOtherDefaults
        ? await db.$transaction(async (tx) => {
            await tx.salaryStructure.updateMany({ where: clearOtherDefaults, data: { isDefault: false } });
            return tx.salaryStructure.update({ where: { id: data.id }, data: payload });
          })
        : await db.salaryStructure.update({ where: { id: data.id }, data: payload });
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
        if (clearOtherDefaults) {
          await tx.salaryStructure.updateMany({ where: clearOtherDefaults, data: { isDefault: false } });
        }
        return tx.salaryStructure.create({ data: payload });
      });
    }
    await logAudit({
      actor: auth,
      action: "payroll.structure_saved",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: user.name,
      detail: `${auth.name} ${data.id ? "revised" : "created"} the salary structure for ${user.name} (${data.components.length} components, effective ${payload.effectiveFrom.toISOString().slice(0, 10)}${data.isDefault === true ? " — now the workspace default package" : ""}).`,
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
// P14 (PR-33 / PR-04) — bulk tools: the bulk structure assignment + the
// run's employee filter.
// ---------------------------------------------------------------------------

/** P14 (PR-33) — assign ONE component set to many employees at once. Each
 * employee's ACTIVE structure is replaced in their OWN transaction
 * (retire + create — the F-R1 discipline, so a crash can never leave an
 * employee with zero ACTIVE structures), with per-employee isolation: one
 * bad record never blocks the rest, the summary is loud and the counts
 * honest (the P13 pattern). Employees without an existing structure simply
 * get their first one (nothing to retire). */
export async function bulkAssignStructure(input: unknown): Promise<ActionResult<{ replaced: number; createdFresh: number; failures: Array<{ userId: string; reason: string }> }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(bulkAssignStructureSchema, input);

    // The employees must exist (a typo'd id is a per-employee failure, not
    // a silent skip).
    const users = await db.user.findMany({
      where: { id: { in: data.userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const existingActive = await db.salaryStructure.findMany({
      where: { userId: { in: data.userIds }, isActive: true },
      select: { userId: true },
    });
    const hadActive = new Set(existingActive.map((s) => s.userId));

    const componentsJson = JSON.stringify(data.components);
    const effectiveFrom = data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00Z`) : new Date();
    const failures: Array<{ userId: string; reason: string }> = [];
    let replaced = 0;
    let createdFresh = 0;

    for (const userId of data.userIds) {
      if (!nameById.has(userId)) {
        failures.push({ userId, reason: "employee not found" });
        continue;
      }
      try {
        await db.$transaction(async (tx) => {
          if (hadActive.has(userId)) {
            await tx.salaryStructure.updateMany({
              where: { userId, isActive: true },
              data: { isActive: false },
            });
          }
          await tx.salaryStructure.create({
            data: {
              userId,
              components: componentsJson,
              notes: data.notes,
              frequency: data.frequency,
              effectiveFrom,
              isActive: true,
              createdById: auth.userId,
            },
          });
        });
        if (hadActive.has(userId)) replaced += 1;
        else createdFresh += 1;
      } catch (e) {
        failures.push({
          userId,
          reason: e instanceof Error ? e.message : "unknown error",
        });
      }
    }

    const done = replaced + createdFresh;
    if (done === 0) {
      // Nothing landed at all — refuse loudly rather than pretending.
      throw new AuthorizationError(
        `Bulk assignment created no structures — ${failures.length} failure(s): ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}.`,
      );
    }

    await logAudit({
      actor: auth,
      action: "payroll.structures_bulk_assigned",
      entityType: "SALARY_STRUCTURE",
      entityId: data.userIds[0],
      entityLabel: `${done} employee(s)`,
      detail: `${auth.name} bulk-assigned a ${data.frequency.toLowerCase()} structure (${data.components.length} components) to ${done} employee(s) — ${replaced} replaced an active structure, ${createdFresh} first structure${failures.length > 0 ? `; ${failures.length} FAILED: ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}` : ""}.`,
    });
    revalidatePath("/");
    return { replaced, createdFresh, failures };
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

/** P15 (PR-06) — null-safe read of the frozen charge breakdown (Prisma's
 * JsonValue narrowed to the stored shape; anything malformed reads as null
 * rather than crashing the payroll views — the money lives in lopDays and
 * the LOP line, the detail is display). */
function parseLopDetail(v: unknown): LopDetailT | null {
  if (v == null || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const leave = Array.isArray(d.leave)
    ? d.leave.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return {
          leaveTypeId: typeof row.leaveTypeId === "string" ? row.leaveTypeId : "",
          code: typeof row.code === "string" ? row.code : "—",
          name: typeof row.name === "string" ? row.name : "(unknown leave)",
          takenDays: num(row.takenDays),
          chargedDays: num(row.chargedDays),
          fraction: num(row.fraction),
          paid: row.paid === true,
        };
      })
    : [];
  return { absentDays: num(d.absentDays), halfDays: num(d.halfDays), unmarkedDays: num(d.unmarkedDays), leave };
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
        status: r.status as "OPEN" | "LOCKED",
        lockedBy: r.lockedById ? lockerMap.get(r.lockedById) ?? null : null,
        lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
        payslipCount: r.payslips.length,
        totalGross: Math.round(r.payslips.reduce((s, p) => s + p.gross, 0) * 100) / 100,
        totalNet: Math.round(r.payslips.reduce((s, p) => s + p.net, 0) * 100) / 100,
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
export async function createPayrollRun(input: unknown): Promise<ActionResult<{ id: string; payslipCount: number; adjustmentsApplied: number; adjustmentsSkipped: number; failures: Array<{ userId: string; slipNo: string; reason: string }> }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createPayrollRunSchema, input);

    // P10 — the kernel resolves the cadence + anchor into ONE window; the
    // period key it returns is the unique human identifier. Invalid anchors
    // (2026-02-30) are refused here, before any read.
    const window = resolvePayrollWindow(data.frequency, data.anchorDate);
    if (!window) throw new AuthorizationError("Pick a valid anchor date (YYYY-MM-DD) inside the window.");

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
    if (structures.length === 0) {
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
      structures.map((s) => s.userId),
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
    const slipUserIds = new Set(structures.map((s) => s.userId));
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
    const windowEarnings = (components: OfferComponent[]) =>
      windowEarningsFromStructure(components, window.frequency, earningsYear);

    // P13 — compute EVERY slip's data purely first (the map never throws:
    // the kernels are guarded), keeping each slip's adjustment consumption
    // attached so the chunked writes below can commit them per slip (S17).
    type SlipPlan = {
      data: {
        userId: string; slipNo: string; earnings: string; deductions: string;
        lopDays: number; lopSource: string; paidDays: number; gross: number; net: number; withholdStatus: string;
        lopDetail: Prisma.InputJsonValue | undefined;
      };
      consumed: ConsumedEntry[];
    };
    const slipPlans: SlipPlan[] = structures.map((s, i) => {
      const facts = lopByUser.get(s.userId)
        ?? { lopDays: 0, paidDays: runWorkingDays, clippedFrom: false, clippedUntil: false, lopDetail: null };
      const components = parseComponents(s.components);
      const earnings = scaleEarningsToPaidDays(
        windowEarnings(components),
        facts.paidDays,
        runWorkingDays,
      );
      // P23 (PR-02) — the structure's flat deduction lines materialize on
      // every slip (FIXED / percent-of-basic / percent-of-gross, annual
      // resolution ÷ windows — flat per window: absence already docks the
      // day-scaled earnings through the LOP line). Pre-P23 structures carry
      // no DEDUCTION lines, so their slips stay byte-identical.
      const structureDeductions = windowDeductionsFromStructure(components, window.frequency, earningsYear);
      // P9 (PR-B26) — the overtime line prices from the structure's
      // UNSCALED per-window gross (÷ working days ÷ 8h) and lands AFTER
      // the LOP basis: overtime minutes were worked on attended
      // days, so absence docking never touches them (the S6 spirit).
      const otPayout = planOvertimePayout({
        enabled: overtimePayEnabled,
        minutes: otByUser.get(s.userId) ?? null,
        monthlyGross: lineSum(windowEarnings(components)),
        workingDays: runWorkingDays,
      });
      const earningsWithOt: PayslipLine[] = otPayout
        ? [...earnings, { key: OVERTIME_LINE_KEY, label: overtimeLineLabel(otPayout), amount: otPayout.amount }]
        : earnings;
      const lopDays = facts.lopDays;
      // The auto LOP line is materialized at creation (net totals are
      // honest immediately — no per-slip save needed to see the dock).
      // S6 — the LOP basis excludes window-exempt lines (a flat
      // allowance is not reduced by absent days). P23 — the structure's
      // flat deductions ride the base BEFORE the LOP line, so the
      // percent-of-net pass below sees the fully docked net.
      const baseDeductions = lopDays > 0
        ? withLopLine(structureDeductions, lopBasisGross(earnings), lopDays, window.periodKey, runWorkingDays > 0 ? runWorkingDays : undefined)
        : structureDeductions;
      // P1 — adjustments land on the docked base (post scaling,
      // post LOP, overtime included), the rounding line wraps the
      // final net. P23 — the structure's PERCENT_OF_NET lines ride the
      // SAME two-pass kernel, PREPENDED before the period's adapter rows
      // (the package's own deductions resolve first, sequentially on the
      // running net; one kernel serves adapter + catalog).
      const applied = applyAdjustments(
        { earnings: earningsWithOt, deductions: baseDeductions },
        [...structureNetDeductionRows(components), ...(dueByUser.get(s.userId) ?? [])],
        window.periodKey,
      );
      const consumed: ConsumedEntry[] = [];
      for (const c of applied.consumed) {
        const row = (dueByUser.get(s.userId) ?? []).find((r) => r.id === c.id);
        if (row) consumed.push({ row, final: c.final });
      }
      // Synthetic struct: ids never match a stored row — filtered out so
      // the run's failure summary stays about real adapter rows.
      kernelSkips.push(...applied.skipped.filter((sk) => !sk.id.startsWith("struct:")));
      const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, roundingMode);
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
          paidDays: facts.paidDays,
          gross,
          net,
          withholdStatus: heldUserIds.has(s.userId) ? "WITHHELD" : "",
        },
        consumed,
      };
    });

    // P13 — the first CHUNK rides the run-creation transaction (the
    // ≤30-employee path is byte-identical to the pre-P13 world: one
    // transaction, run + slips + consumption all-or-nothing).
    const CHUNK = 30;
    const firstChunk = slipPlans.slice(0, CHUNK);
    const overflow = slipPlans.slice(CHUNK);
    const consumedEntries: ConsumedEntry[] = firstChunk.flatMap((p) => p.consumed);

    const run = await db.$transaction(async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          period: window.periodKey,
          frequency: window.frequency,
          startDate: window.start,
          endDate: window.end,
          status: "OPEN",
          createdById: auth.userId,
          workingDays: runWorkingDays,
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
      detail: `${auth.name} created the ${run.period} (${window.frequency}) payroll run with ${payslipCount} payslips from the active ${window.frequency.toLowerCase()} salary structures${data.userIds && data.userIds.length > 0 ? ` (filtered to ${data.userIds.length} selected employee(s))` : ""}${overflow.length > 0 ? ` (${firstChunk.length} in the creation batch + ${overflow.length - failures.length} chunked beyond 30)` : ""}${failures.length > 0 ? ` — ${failures.length} payslip(s) FAILED with reasons: ${failures.map((f) => `${f.slipNo} (${f.reason})`).join("; ")}` : ""}${autoLopCount > 0 ? ` (${autoLopCount} with auto-derived loss-of-pay from attendance and unpaid leave)` : ""}${clippedCount > 0 ? ` (${clippedCount} scaled to mid-period employment windows)` : ""}${otSlipCount > 0 ? ` (${otSlipCount} with attendance overtime)` : ""}${heldUserIds.size > 0 ? ` (${heldUserIds.size} payslip(s) WITHHELD under an active salary hold)` : ""}${adjustmentsApplied > 0 || adjustmentsSkipped > 0 ? ` (${adjustmentsApplied} adjustment(s) consumed${adjustmentsSkipped > 0 ? `, ${adjustmentsSkipped} skipped with reason` : ""})` : ""}`,
    });
    revalidatePath("/");
    return { id: run.id, payslipCount, adjustmentsApplied, adjustmentsSkipped, failures };
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
          availableDays: Math.round((r.entitled + r.carriedOver - r.used) * 100) / 100,
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
      }));

    return {
      run: {
        id: run.id,
        period: run.period,
        frequency: run.frequency as PayrollRunT["frequency"],
        startDate: run.startDate ? run.startDate.toISOString() : null,
        endDate: run.endDate ? run.endDate.toISOString() : null,
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
    // P15 (PR-06) — a manual override replaces the derivation, so its
    // frozen breakdown no longer describes the charge: drop it (the modal
    // honestly says "manually set by HR"). An unchanged save keeps it.
    const lopDetailWrite = lopDaysChanged ? Prisma.DbNull : undefined;
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
        lopDetail: lopDetailWrite,
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
    // P10 — the joiner's structure cadence must match the run's (the same
    // frequency-matched rule run creation applies).
    const runFrequency = (run.frequency || "MONTHLY") as PayrollFrequency;
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
    // P10 — the run's REAL window (stored dates, falling back to the parsed
    // period key for pre-backfill rows) drives every per-slip derivation.
    const windowStart = runWindowStart(run.period, run.startDate);
    const windowEnd = runWindowEnd(run.period, run.endDate);
    if (!windowStart || !windowEnd) {
      throw new AuthorizationError("The run's period is not a parseable payroll window — recreate the run.");
    }
    const components = parseComponents(structure.components);
    const earnings = windowEarningsFromStructure(
      components,
      runFrequency,
      windowStart.getUTCFullYear(),
    );
    // F1.4 — same derivation as createPayrollRun, for this one joiner.
    const periodHolidays = await getHolidayLookup(windowStart, windowEnd);
    const lopByUser = await deriveLopDaysForUsers([data.userId], { start: windowStart, end: windowEnd }, periodHolidays);
    const facts = lopByUser.get(data.userId)
      ?? { lopDays: 0, paidDays: run.workingDays, clippedFrom: false, clippedUntil: false, lopDetail: null };
    const lopDays = facts.lopDays;
    // S5 (PR-B06) — the joiner's earnings scale to their employment window:
    // pre-join days are no longer a manual HR LOP call, the run snapshots
    // the pro-rated lines (and paidDays) directly.
    const scaledEarnings = scaleEarningsToPaidDays(
      earnings,
      facts.paidDays,
      run.workingDays > 0 ? run.workingDays : undefined,
    );
    // P23 (PR-02) — the joiner's structure deductions ride the slip exactly
    // like run creation (flat per window; percent-of-net through the kernel).
    const structureDeductions = windowDeductionsFromStructure(
      components,
      runFrequency,
      windowStart.getUTCFullYear(),
    );
    // S6 — the LOP basis excludes window-exempt lines.
    const baseDeductions = lopDays > 0
      ? withLopLine(structureDeductions, lopBasisGross(scaledEarnings), lopDays, run.period, run.workingDays > 0 ? run.workingDays : undefined)
      : structureDeductions;
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
    // P9 (PR-B26) — the joiner's overtime line, same rule as run creation
    // (UNSCALED gross basis, lands after the LOP basis).
    const otPayout = planOvertimePayout({
      enabled: overtimePayEnabled,
      minutes: otMinutes > 0 ? otMinutes : null,
      monthlyGross: lineSum(earnings),
      workingDays: run.workingDays,
    });
    const earningsWithOt: PayslipLine[] = otPayout
      ? [...scaledEarnings, { key: OVERTIME_LINE_KEY, label: overtimeLineLabel(otPayout), amount: otPayout.amount }]
      : scaledEarnings;
    // P1 (F2.3) — this joiner's due adjustments ride the new slip (same
    // kernel + same transaction discipline as run creation).
    const pendingAdjustments = await db.payAdjustment.findMany({
      // P10 — no period-string pre-filter: the window-aware predicate
      // decides due-ness (isDueInPeriod below).
      where: { status: "PENDING", userId: data.userId },
      orderBy: { createdAt: "asc" },
    });
    const due = pendingAdjustments.filter((row) => isDueInPeriod(row, run.period));
    // P23 — the joiner's percent-of-net structure lines ride the same
    // two-pass kernel, prepended before the adapter rows (as at run
    // creation).
    const applied = applyAdjustments(
      { earnings: earningsWithOt, deductions: baseDeductions },
      [...structureNetDeductionRows(components), ...due],
      run.period,
    );
    const { earnings: finalEarnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, roundingMode);
    const { gross, net } = payslipTotals(finalEarnings, deductions);
    const createData = {
      runId: run.id,
      userId: data.userId,
      earnings: JSON.stringify(finalEarnings),
      deductions: JSON.stringify(deductions),
      lopDays,
      lopSource: "AUTO",
      lopDetail: facts.lopDetail ? (facts.lopDetail as unknown as Prisma.InputJsonValue) : undefined,
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
      detail: `${auth.name} added payslip ${slip.slipNo} to the ${run.period} run${applied.consumed.length > 0 ? ` (${applied.consumed.length} adjustment(s) consumed)` : ""}${otPayout ? ` — includes ${otPayout.amount > 0 ? `overtime of $${otPayout.amount.toLocaleString("en-NZ")}` : "overtime"}` : ""}${withheld ? " — WITHHELD under an active salary hold (net not disbursed until released)" : ""}.`,
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
    const total = Math.round(run.payslips.reduce((s, p) => s + p.net, 0) * 100) / 100;
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

/** P20 (PR-R01/PR-R02) — the per-run CSV exports (payroll:manage). LOCKED
 * runs only: paid money is the only money worth exporting — an OPEN run's
 * numbers are drafts HR may still edit. The register lists every slip
 * (gross/deductions/net + LOP + withhold state); the bank remittance lists
 * the DISBURSED payments (WITHHELD nets never reach the bank file) with
 * the account column blank — Fernly stores no bank details, the employer's
 * bank maps accounts from its records. Both carry the non-statutory
 * disclaimer; the build is pure (lib/payroll-csv.ts, golden-file tested).
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
        deductions: Math.round(parsePayslipLines(s.deductions).reduce((sum, l) => sum + l.amount, 0) * 100) / 100,
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
          availableDays: Math.round((r.entitled + r.carriedOver - r.used) * 100) / 100,
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
      }));
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
      // P10 — no period-string pre-filter: the window-aware predicate
      // decides due-ness (isDueInPeriod below).
      where: { status: "PENDING" },
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
