// ---------------------------------------------------------------------------
// F2.1 — full-and-final statement, pure computation
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.1;
//  docs/Fernly_Policy_Engine_Design.md §5.5; benchmark EM-16 lite).
//
// The exit-interview status vocabulary also lives here so the offboarding
// module owns one pure file (law 1 of the policy-engine design: rules are
// pure — no I/O, no clock, `asOf` injected; services obey).
//
// WHAT THE LITE STATEMENT ASSEMBLES (payables minus receivables):
//
// Payables
//   • SALARY — the net of every OPEN payroll run's payslip for the exiting
//     employee ("the current OPEN run's net if unprocessed"). A LOCKED run
//     was PAID — it is not owed, so it never appears.
//   • ENCASHMENT — unused leave of PAID types: positive ledger available ×
//     daily rate. The rate basis is the F2.2 default
//     (GROSS_OVER_WORKING_DAYS): active structure's monthly gross ÷ the
//     holiday-aware working days of the last-working-day month (F1.1 math —
//     the same denominator the payslip LOP line divides by). F2.2's knobs
//     (encashable flag, caps, alternate basis) will make this configurable;
//     until then every paid type's positive balance encashes at the single
//     structure rate.
//
// Receivables
//   • ADVANCE_LEAVE — negative ledger balances of paid types (F2.4's
//     advance-leave floor world): days taken ahead of accrual are days the
//     employer advanced; at exit they convert back to money at the same
//     daily rate (design doc §5.2 — "an advance leave is days owed to the
//     employer, docked … if the exit FnF encashes a negative balance").
//
// P38 (EM-16/EM-B12) — the line space extends: pending PayAdjustment
// earnings (retention-bonus installments, unconsumed one-shot incentives)
// and APPROVED-unpaid encashment requests fold into the LIVE statement as
// payables (what the company still owes the leaver beyond salary + leave).
// Salary-advance receivables ride the P39 advances epic. Still out of
// scope: loans proper (the later un-decline epic), asset obligations
// (EM-B13). P7 landed the gratuity slabs (F3.3): see the gratuity block
// below and lib/gratuity.ts.
//
// Balances are read for the asOf YEAR only (the ledger projection folds
// carry-over into the current year's CARRY rows via the F2.4 rollover —
// prior-year leftovers that never rolled are out of the lite scope).
//
// HONESTY RULES
//   • An OPEN run WITHOUT a payslip for the employee yields a NOTE, not a
//     line — "add one before settling if salary is owed" — so the gap is
//     visible instead of silently understated.
//   • No active structure → rate 0.00 and a note; the day counts still
//     list (the statement shows what cannot yet be valued, not nothing).
//   • Unpaid types never value: excluded with a note (no cash value).
//   • netPayable may be NEGATIVE — that is a real claim the company has on
//     the leaver, rendered as-is (never silently clamped to zero).
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";
import {
  computeGratuity,
  finalAverageEarnings,
  gratuityNote,
  serviceLengthBetween,
  type GratuitySlabInput,
} from "@/lib/gratuity";
import type { FnFComputedT, FnFLineT, ExitInterviewStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Exit-interview vocabulary (EM-15) — pure status machine
// ---------------------------------------------------------------------------

export const EXIT_INTERVIEW_STATUSES: ExitInterviewStatus[] = [
  "PENDING", "SCHEDULED", "COMPLETED", "CANCELLED",
];

export const EXIT_INTERVIEW_STATUS_LABELS: Record<ExitInterviewStatus, string> = {
  PENDING: "Pending",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** The statuses that hold a LIVE interview (at most one per employee);
 * CANCELLED rows are kept as history but free the employee for a new one. */
export const EXIT_INTERVIEW_LIVE_STATUSES: ExitInterviewStatus[] = ["PENDING", "SCHEDULED"];

export function canScheduleExitInterview(status: ExitInterviewStatus): boolean {
  return status === "PENDING" || status === "SCHEDULED"; // rescheduling allowed
}

export function canCompleteExitInterview(status: ExitInterviewStatus): boolean {
  return status === "PENDING" || status === "SCHEDULED"; // may be held ad-hoc
}

export function canCancelExitInterview(status: ExitInterviewStatus): boolean {
  return status === "PENDING" || status === "SCHEDULED";
}

// ---------------------------------------------------------------------------
// Statement computation
// ---------------------------------------------------------------------------

/** One leave account feeding the encashment/recovery math. */
export interface FnFLeaveAccount {
  leaveTypeId: string;
  name: string;
  /** LeaveType.paid — unpaid types never value (excluded, noted). */
  paid: boolean;
  /** Ledger projection of (user, type, asOf year): Σ all deltas. */
  available: number;
}

/** One OPEN payroll run's relationship to the exiting employee. */
export interface FnFOpenRun {
  /** "YYYY-MM". */
  period: string;
  /** The employee's payslip net in the run; null = no payslip yet. */
  payslipNet: number | null;
  /** P8 (PR-19/PR-B13) — true when a payslip exists but its net was
   * already released (WITHHELD → RELEASED): the money pays through the
   * WITHHOLDING_RELEASE adjustment, so it is not a payable here. A still-
   * WITHHELD slip (false) IS owed — the hold is not a waiver. */
  withheldReleased?: boolean;
}

export interface FnFInput {
  /** yyyy-mm-dd — the day the computation runs (injected clock). */
  asOf: string;
  /** yyyy-mm-dd — the exit basis (guaranteed on EXITED profiles by the
   * F1.6 transition guard; null defensively yields a note, no lines). */
  lastWorkingDay: string | null;
  /** Monthly gross from the ACTIVE salary structure; null = none. */
  monthlyGross: number | null;
  /** Rate-basis period — the last-working-day month ("YYYY-MM"). */
  ratePeriod: string;
  /** Holiday-aware working days of the rate-basis period (F1.1 math,
   * service-resolved; the pure kernel trusts the input). */
  rateWorkingDays: number;
  openRuns: FnFOpenRun[];
  leaveAccounts: FnFLeaveAccount[];
  /** P7 (F3.3) — the gratuity rule as resolved by the action: config,
   * the earnings samples already sliced to the averaging window, and
   * the employee's hire date. Disabled rules arrive as enabled:false
   * and produce nothing. */
  gratuity: {
    enabled: boolean;
    averagingMonths: number;
    slabs: GratuitySlabInput[];
    /** Last-N monthly grosses (LOCKED payslips, structure fallback). */
    earningsSamples: number[];
    /** Where the samples came from (the note names the basis). */
    earningsBasis: "PAYSLIPS" | "STRUCTURE";
    /** yyyy-mm-dd — EmployeeProfile.hireDate; null = unknown. */
    hireDate: string | null;
  };
  /** P38 (EM-16/EM-B12) — the employee's PENDING PayAdjustment rows that
   *  still owe money at exit: retention-bonus installments not yet paid,
   *  unconsumed one-shot incentives/bonuses. Each folds into the LIVE
   *  statement as a payable line (resolved like the run would resolve it:
   *  FIXED magnitudes only here — percent rows value at their remaining
   *  FIXED-equivalent snapshot when the action has one, else a note). */
  pendingAdjustments?: FnFPendingAdjustment[];
  /** P38 (EM-16/EM-B12) — the employee's APPROVED-but-unpaid encashment
   *  requests (days already consumed from the ledger — the money was
   *  approved, the paying run never locked). Each is a payable: the
   *  frozen amount snapshot, not a revaluation. */
  pendingEncashments?: FnFPendingEncashment[];
}

/** One PENDING PayAdjustment feeding the P38 payable line. */
export interface FnFPendingAdjustment {
  /** PayAdjustment.id. */
  id: string;
  /** Provenance label (RETENTION_BONUS, INCENTIVE, MANUAL…). */
  sourceType: string;
  /** The row's display label (already carries the source's wording). */
  label: string;
  /** FIXED: the magnitude; PERCENT_*: null (the note explains the
   *  unresolved basis — percent rows value only when the action resolved
   *  them to a concrete amount). */
  amount: number | null;
  /** "YYYY-MM" — the row's first period (the label names it). */
  period: string;
  /** RECURRING rows: how many periods remain unpaid at exit (the action
   *  computes it from endPeriod vs the last LOCKED run; ONE_SHOT rows
   *  carry 1). */
  remainingPeriods: number;
}

/** One APPROVED-unpaid encashment feeding the P38 payable line. */
export interface FnFPendingEncashment {
  /** LeaveEncashment.id. */
  id: string;
  /** The leave type's name (label context). */
  leaveName: string;
  /** Days sold (already consumed from the ledger). */
  days: number;
  /** The frozen amount snapshot from approval. */
  amount: number;
  /** The payout period the money was slated for. */
  payoutPeriod: string;
}

/** Per-day leave value: monthly gross ÷ working days, rounded once. 0 when
 * uncomputable (no structure, non-positive denominator) — the caller's
 * notes explain WHY it is 0, the number stays honest. */
export function dailyLeaveRate(monthlyGross: number | null, workingDays: number): number {
  if (monthlyGross === null || !(monthlyGross > 0) || !(workingDays > 0)) return 0;
  return round2(monthlyGross / workingDays);
}

/** Build the statement. Pure: same input → same lines, every time. */
export function computeFullAndFinal(input: FnFInput): FnFComputedT {
  const notes: string[] = [];
  const lines: FnFLineT[] = [];

  if (!input.lastWorkingDay) {
    return {
      asOf: input.asOf,
      lines: [],
      notes: [
        "No last working day recorded — record the exit (with a last working day) before settling.",
      ],
      payableTotal: 0,
      receivableTotal: 0,
      netPayable: 0,
      gratuity: null,
      rateBasis: {
        period: input.ratePeriod,
        workingDays: input.rateWorkingDays,
        monthlyGross: input.monthlyGross,
        dailyRate: 0,
      },
    };
  }

  // --- Payable: unprocessed salary (OPEN runs only — LOCKED means paid). ---
  for (const run of input.openRuns) {
    if (run.withheldReleased) {
      notes.push(
        `Withheld salary for the open ${run.period} run was already released — it pays through the release adjustment, not this statement.`,
      );
      continue;
    }
    if (run.payslipNet === null) {
      notes.push(
        `No payslip for this employee in the open ${run.period} run — add one before settling if salary is owed for that period.`,
      );
      continue;
    }
    if (run.payslipNet === 0) continue; // a zero-net slip owes nothing
    lines.push({
      kind: "SALARY",
      label: `Unprocessed salary — ${run.period} run (net)`,
      days: null,
      rate: null,
      amount: round2(run.payslipNet),
    });
  }

  // --- Rate basis (the F2.2 default until its knobs land). ---
  const dailyRate = dailyLeaveRate(input.monthlyGross, input.rateWorkingDays);
  if (input.monthlyGross === null) {
    notes.push(
      "No active salary structure — leave lines value at $0.00 per day (day counts listed for review).",
    );
  } else if (dailyRate === 0) {
    notes.push(
      `Rate basis has ${input.rateWorkingDays} working day(s) — leave lines value at $0.00 per day.`,
    );
  }

  // --- Payable: encashment / Receivable: advance-leave recovery. ---
  for (const account of input.leaveAccounts) {
    const available = Number.isFinite(account.available) ? account.available : 0;
    if (available === 0) continue;
    if (!account.paid) {
      notes.push(
        `${account.name}: ${available} day(s) unused — unpaid leave has no cash value (excluded).`,
      );
      continue;
    }
    if (available > 0) {
      lines.push({
        kind: "ENCASHMENT",
        label: `${account.name} — ${available} day(s) unused`,
        days: round2(available),
        rate: dailyRate,
        amount: round2(available * dailyRate),
      });
    } else {
      // Negative: days taken in advance — money the company advanced.
      const owed = round2(-available);
      lines.push({
        kind: "ADVANCE_LEAVE",
        label: `${account.name} — ${owed} day(s) taken in advance`,
        days: owed,
        rate: dailyRate,
        amount: -round2(owed * dailyRate), // negative = receivable side
      });
    }
  }

  // --- P38 (EM-16/EM-B12): pending bonus/adjustment payables ---
  for (const adj of input.pendingAdjustments ?? []) {
    if (adj.amount === null || !(adj.amount > 0)) {
      notes.push(
        `Pending ${adj.sourceType.toLowerCase().replace("_", " ")} adjustment "${adj.label}" (${adj.period}) is percent-based — it values when the paying run resolves it; settle after that run locks or record the cash equivalent.`,
      );
      continue;
    }
    lines.push({
      kind: "BONUS",
      label: adj.remainingPeriods > 1
        ? `${adj.label} — ${adj.remainingPeriods} unpaid installment(s) from ${adj.period}`
        : `${adj.label} — unpaid (${adj.period})`,
      days: null,
      rate: null,
      amount: round2(adj.amount * adj.remainingPeriods),
    });
  }

  // --- P38 (EM-16/EM-B12): APPROVED-unpaid encashment payables ---
  for (const enc of input.pendingEncashments ?? []) {
    if (!(enc.amount > 0)) continue;
    lines.push({
      kind: "PENDING_ENCASHMENT",
      label: `${enc.leaveName} encashment — ${enc.days} day(s) approved, unpaid (${enc.payoutPeriod})`,
      days: round2(enc.days),
      rate: null,
      amount: round2(enc.amount),
    });
  }

  // --- P7 (F3.3): gratuity — slab walk over completed service years. ---
  let gratuity: FnFComputedT["gratuity"] = null;
  if (input.gratuity.enabled) {
    if (!input.gratuity.hireDate) {
      notes.push(
        "No hire date recorded — gratuity cannot be computed (fix the profile before settling).",
      );
    } else {
      const service = serviceLengthBetween(input.gratuity.hireDate, input.lastWorkingDay);
      const averageMonthlyEarnings = finalAverageEarnings(input.gratuity.earningsSamples);
      if (averageMonthlyEarnings === null) {
        notes.push(
          "Gratuity rule is on but no earnings basis exists (no payslips, no active structure) — the line values at $0.00 until one does.",
        );
      } else if (service.completedYears === 0) {
        notes.push(
          `Gratuity: ${service.totalMonths} completed month${service.totalMonths === 1 ? "" : "s"} of service — under one completed year, the rule pays nothing.`,
        );
      } else {
        const computation = computeGratuity({
          service,
          averageMonthlyEarnings,
          slabs: input.gratuity.slabs,
        });
        gratuity = {
          completedYears: service.completedYears,
          extraMonths: service.extraMonths,
          averageMonthlyEarnings,
          averagingMonths: input.gratuity.averagingMonths,
          breakdown: computation.breakdown,
        };
        if (computation.amount > 0) {
          lines.push({
            kind: "GRATUITY",
            label: `Gratuity — ${service.completedYears} yr ${service.extraMonths} mo of service (slab rule)`,
            days: null,
            rate: null,
            amount: computation.amount,
          });
        }
        notes.push(
          gratuityNote({
            service,
            averagingMonths: input.gratuity.averagingMonths,
            averageMonthlyEarnings,
            earningsBasis: input.gratuity.earningsBasis,
            computation,
          }),
        );
      }
    }
  }

  const payableTotal = round2(
    lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0),
  );
  const receivableTotal = round2(
    lines.filter((l) => l.amount < 0).reduce((s, l) => s + -l.amount, 0),
  );

  return {
    asOf: input.asOf,
    lines,
    notes,
    payableTotal,
    receivableTotal,
    netPayable: round2(payableTotal - receivableTotal),
    gratuity,
    rateBasis: {
      period: input.ratePeriod,
      workingDays: input.rateWorkingDays,
      monthlyGross: input.monthlyGross,
      dailyRate,
    },
  };
}

/** Parse the stored lines JSON defensively (schema stores TEXT). */
export function parseFnFLines(json: string): FnFLineT[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is FnFLineT =>
        !!l && typeof l === "object" &&
        typeof (l as FnFLineT).kind === "string" &&
        typeof (l as FnFLineT).label === "string" &&
        typeof (l as FnFLineT).amount === "number",
    );
  } catch {
    return [];
  }
}
