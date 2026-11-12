// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Phase 2 (engine wiring): the SLIP kernel.
//
// Everything a payroll run needs to turn one employee's payslip lines into
// statutory deduction lines + the frozen Payslip.statutory snapshot:
//
//   classifyComponentsForStatutory() — the Task 3.3 component-mapping
//     adapter: which earning keys are excluded from the taxable gross and
//     which deduction keys dock it pre-tax.
//   statutoryTaxableGross()          — the gross the engine may tax: taxable
//     earnings, minus the LOP dock (proportionally, only the taxable share of
//     the docked basis) and pre-tax deductions. Money not received is not
//     taxed; money that is not taxable income never enters a wage base.
//   planSlipStatutory()              — the whole plan: adapt the profile row
//     (system defaults when none exists), run the pure engine against the
//     run's frozen rate set, build the employee-side deduction lines (keys
//     paye/acc/ks/sl — non-zero only) and the JSON snapshot, and surface the
//     KiwiSaver auto-enrolment decision the PAYROLL ACTION must persist.
//   parseStatutorySnapshot()         — the defensive read-side parser.
//
// Pure: no database, no clock (payPeriodEnd arrives as a value). The impure
// seams stay in the server action (loading profiles / catalog / rate set and
// persisting enrolments with audit entries — see payroll.ts).
//
// Auto-enrolment persistence contract (Task 1.2 design): when the plan's
// autoEnrol is non-null, the action writes kiwiSaverRate = the rate that
// applied (the rate-set default) onto EmployeeTaxProfile — the explicit
// election makes the transition sticky so the time rules never re-trigger —
// inside the SAME transaction as the slip, then records an audit entry.
// ---------------------------------------------------------------------------

import type { PayslipStatutoryT } from "@/lib/types";
import {
  LOP_LINE_KEY,
  isStatutoryLineKey,
  lineSum,
  lopBasisGross,
  round2,
  type PayslipLine,
} from "@/lib/payroll-math";
import {
  calculateNzStatutoryWithSet,
  toNzTaxProfile,
  type NzStatutoryResult,
  type NzTaxProfileRow,
} from "./calculate";
import type { NzPayFrequency, NzRateSetParams } from "./types";

// ---------------------------------------------------------------------------
// Component classification (Task 3.3 mapping → engine inputs).
// ---------------------------------------------------------------------------

/** Structural slice of a SalaryComponent catalog row. */
export interface StatutoryComponentRow {
  code: string;
  taxApplicable: boolean;
  statutoryCategory: string;
  wageBaseRef: string;
}

/** The catalog flattened into the two sets the taxable-gross math needs. */
export interface ComponentTaxClassification {
  /** Earning-line keys that NEVER enter a statutory wage base (non-taxable
   *  allowances, reimbursements, statistical rows, employer lines). Lines
   *  NOT in the catalog default to taxable — the conservative posture. */
  excludedEarnings: Set<string>;
  /** Deduction-line keys that reduce the taxable gross BEFORE tax (salary
   *  sacrifice & co.: statutoryCategory PRE_TAX_DEDUCTION). */
  preTaxDeductions: Set<string>;
}

/** Flatten the active catalog rows into the engine's classification. A row
 * feeds the taxable gross only when it is taxApplicable AND wageBaseRef
 * GROSS AND category TAXABLE_EARNING; contradictory admin data falls to the
 * excluded side (never silently tax something mapped out). */
export function classifyComponentsForStatutory(
  rows: StatutoryComponentRow[],
): ComponentTaxClassification {
  const out: ComponentTaxClassification = {
    excludedEarnings: new Set(),
    preTaxDeductions: new Set(),
  };
  for (const r of rows) {
    const taxable =
      r.taxApplicable && r.wageBaseRef === "GROSS" && r.statutoryCategory === "TAXABLE_EARNING";
    if (!taxable) out.excludedEarnings.add(r.code);
    if (r.statutoryCategory === "PRE_TAX_DEDUCTION") out.preTaxDeductions.add(r.code);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Taxable gross.
// ---------------------------------------------------------------------------

/**
 * The gross the statutory engine may tax for one slip. Pure.
 *
 *   taxableGross = Σ taxable earnings − LOP dock on the taxable share −
 *                  Σ pre-tax deductions
 *
 * The LOP line docks the payment-day basis (lopBasisGross semantics), which
 * may mix taxable and non-taxable lines — the dock is split proportionally so
 * only the taxable share reduces the tax base. Statistical lines never count
 * (lineSum already excludes them); the auto rounding line is added after the
 * statutory pass and never reaches this function.
 */
export function statutoryTaxableGross(
  earnings: PayslipLine[],
  deductions: PayslipLine[],
  classification: ComponentTaxClassification,
): number {
  const taxableEarnings = earnings.filter(
    (l) => !l.statistical && !classification.excludedEarnings.has(l.key),
  );
  const lopLine = deductions.find((l) => l.key === LOP_LINE_KEY)?.amount ?? 0;
  const basisAll = lopBasisGross(earnings);
  const basisTaxable = lopBasisGross(taxableEarnings);
  // Only the taxable share of the docked basis leaves the tax base.
  const dock = basisAll > 0 ? (lopLine * basisTaxable) / basisAll : 0;
  const preTax = round2(
    lineSum(deductions.filter((l) => classification.preTaxDeductions.has(l.key))),
  );
  return Math.max(0, round2(lineSum(taxableEarnings) - dock - preTax));
}

// ---------------------------------------------------------------------------
// System-default tax profile.
// ---------------------------------------------------------------------------

/**
 * The posture applied when an employee has no EmployeeTaxProfile row: the
 * model's own defaults (M code, ACTIVE KiwiSaver, PERMANENT employment). NOT
 * the ND code — a missing row is an onboarding gap, not a failed IR330
 * declaration (ND is an explicit recording). KiwiSaver: auto-enrolled at hire
 * at the rate-set default, exactly the statutory default posture for a
 * permanent employee. The snapshot flags defaultedProfile so the payslip and
 * audit stay honest about it.
 */
export function systemDefaultTaxProfileRow(): NzTaxProfileRow {
  return {
    taxCode: "M",
    isCasual: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverEmployeeRate: null,
    kiwiSaverEmployerRate: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: "INC",
    stcStudentLoanRate: null,
    studentLoan: false,
    autoEnrolExemption: "",
    employmentType: "PERMANENT",
    casualHolidayPayInWages: true,
    employmentStartDate: null,
    esctRateOverride: null,
  };
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

export interface PlanSlipStatutoryInput {
  /** The employee (slip owner) — rides the plan for the auto-enrolment. */
  userId: string;
  frequency: NzPayFrequency;
  /** The run's window END — the enrolment time rules evaluate at it. */
  payPeriodEnd: Date;
  /** The run's FROZEN rate set (PayrollRun.rateSetId, resolved once). */
  rateSet: NzRateSetParams;
  /** The employee's EmployeeTaxProfile row; null = system defaults. */
  profileRow: NzTaxProfileRow | null;
  /** Post-adjustment earnings (pre-rounding, no statutory lines yet). */
  earnings: PayslipLine[];
  /** Post-adjustment deductions incl. the LOP line (pre-rounding). */
  deductions: PayslipLine[];
  classification: ComponentTaxClassification;
}

/** A KiwiSaver auto-enrolment the action must persist (see header). */
export interface SlipAutoEnrolment {
  userId: string;
  /** The rate that applied — the rate-set default (the sticky election). */
  rate: number;
  reason: string;
}

export interface SlipStatutoryPlan {
  /** Employee-side deduction lines (amount > 0 only), keys paye/acc/ks/sl. */
  lines: PayslipLine[];
  /** The JSON snapshot for Payslip.statutory (serialize before storing). */
  snapshot: PayslipStatutoryT;
  /** Non-null when a KiwiSaver time rule fired this period. */
  autoEnrol: SlipAutoEnrolment | null;
}

/** Percent formatting for line labels ("3.5%", "10%"). */
function percentLabel(rate: number): string {
  return `${(rate * 100).toLocaleString("en-NZ", { maximumFractionDigits: 2 })}%`;
}

/** Build the employee-side deduction lines. Zero lines are omitted (a $0
 * student-loan row is noise); PAYE clamps at 0 so an IETC overshoot can
 * never mint a negative deduction line (the snapshot keeps the true engine
 * numbers). */
export function statutoryDeductionLines(result: NzStatutoryResult): PayslipLine[] {
  const lines: PayslipLine[] = [];
  const paye = Math.max(0, result.paye.tax);
  if (paye > 0) {
    lines.push({
      key: "paye",
      label: `PAYE income tax (${result.taxCodeApplied})`,
      amount: paye,
    });
  }
  if (result.paye.acc > 0) {
    lines.push({ key: "acc", label: "ACC earners' levy", amount: result.paye.acc });
  }
  if (result.kiwisaver.employee > 0) {
    lines.push({
      key: "ks",
      label: `KiwiSaver employee ${percentLabel(result.kiwisaver.employeeRate)}`,
      amount: result.kiwisaver.employee,
    });
  }
  if (result.studentLoan > 0) {
    lines.push({ key: "sl", label: "Student loan repayment", amount: result.studentLoan });
  }
  return lines;
}

/** Serialize an engine result into the stored snapshot shape. */
export function serializeStatutorySnapshot(
  result: NzStatutoryResult,
  opts: { defaultedProfile: boolean },
): PayslipStatutoryT {
  return {
    taxCode: result.taxCodeApplied,
    rateSetId: result.rateSet.id,
    rateSetLabel: result.rateSet.label,
    ruleVersion: result.ruleVersion,
    frequency: result.frequency,
    payPeriodEnd: result.payPeriodEnd.toISOString().slice(0, 10),
    taxableGross: result.gross,
    defaultedProfile: opts.defaultedProfile,
    paye: {
      tax: result.paye.tax,
      acc: result.paye.acc,
      total: result.paye.total,
      method: result.paye.method,
      ietc: result.paye.ietc,
      annualised: result.paye.annualised,
    },
    kiwiSaver: {
      status: result.kiwisaver.status,
      reason: result.kiwisaver.reason,
      autoEnrolTriggered: result.kiwisaver.autoEnrolTriggered,
      employee: result.kiwisaver.employee,
      employerGross: result.kiwisaver.employerGross,
      esct: result.kiwisaver.esct,
      employerNet: result.kiwisaver.employerNet,
      employeeRate: result.kiwisaver.employeeRate,
      employerRate: result.kiwisaver.employerRate,
      esctRate: result.kiwisaver.esctRate,
    },
    studentLoan: result.studentLoan,
    statutoryNet: result.netPay,
  };
}

/** Plan one slip's statutory computation. Throws NzStatutoryError for
 *  unusable inputs (bad tax code, STC without certificate rate…) — the
 *  action decides per slip whether that blocks or skips. */
export function planSlipStatutory(input: PlanSlipStatutoryInput): SlipStatutoryPlan {
  const defaulted = input.profileRow == null;
  const row = input.profileRow ?? systemDefaultTaxProfileRow();
  const taxProfile = toNzTaxProfile(row);
  const taxableGross = statutoryTaxableGross(
    input.earnings,
    input.deductions,
    input.classification,
  );

  const result = calculateNzStatutoryWithSet({
    gross: taxableGross,
    frequency: input.frequency,
    taxProfile,
    payPeriodEnd: input.payPeriodEnd,
    rateSet: input.rateSet,
  });

  return {
    lines: statutoryDeductionLines(result),
    snapshot: serializeStatutorySnapshot(result, { defaultedProfile: defaulted }),
    autoEnrol: result.kiwisaver.autoEnrolTriggered
      ? {
          userId: input.userId,
          rate: result.kiwisaver.employeeRate,
          reason: result.kiwisaver.reason,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Read-side parser.
// ---------------------------------------------------------------------------

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Defensive parser for the stored Payslip.statutory JSON (null / malformed /
 *  pre-engine → null). */
export function parseStatutorySnapshot(v: unknown): PayslipStatutoryT | null {
  if (v == null || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const paye = s.paye as Record<string, unknown> | undefined;
  const ks = s.kiwiSaver as Record<string, unknown> | undefined;
  if (
    typeof s.taxCode !== "string" ||
    typeof s.rateSetId !== "string" ||
    typeof s.rateSetLabel !== "string" ||
    !paye || !isFiniteNum(paye.tax) || !isFiniteNum(paye.acc) || !isFiniteNum(paye.total) ||
    !ks || !isFiniteNum(ks.employee) || !isFiniteNum(ks.employerGross) ||
    !isFiniteNum(s.studentLoan)
  ) {
    return null;
  }
  return {
    taxCode: s.taxCode,
    rateSetId: s.rateSetId,
    rateSetLabel: s.rateSetLabel,
    ruleVersion: typeof s.ruleVersion === "string" ? s.ruleVersion : "",
    frequency: typeof s.frequency === "string" ? s.frequency : "",
    payPeriodEnd: typeof s.payPeriodEnd === "string" ? s.payPeriodEnd : "",
    taxableGross: isFiniteNum(s.taxableGross) ? s.taxableGross : 0,
    defaultedProfile: s.defaultedProfile === true,
    paye: {
      tax: paye.tax,
      acc: paye.acc,
      total: paye.total,
      method: typeof paye.method === "string" ? paye.method : "",
      ietc: isFiniteNum(paye.ietc) ? paye.ietc : 0,
      annualised: isFiniteNum(paye.annualised) ? paye.annualised : 0,
    },
    kiwiSaver: {
      status: typeof ks.status === "string" ? ks.status : "",
      reason: typeof ks.reason === "string" ? ks.reason : "",
      autoEnrolTriggered: ks.autoEnrolTriggered === true,
      employee: ks.employee,
      employerGross: ks.employerGross,
      esct: isFiniteNum(ks.esct) ? ks.esct : 0,
      employerNet: isFiniteNum(ks.employerNet) ? ks.employerNet : 0,
      employeeRate: isFiniteNum(ks.employeeRate) ? ks.employeeRate : 0,
      employerRate: isFiniteNum(ks.employerRate) ? ks.employerRate : 0,
      esctRate: isFiniteNum(ks.esctRate) ? ks.esctRate : 0,
    },
    studentLoan: s.studentLoan,
    statutoryNet: isFiniteNum(s.statutoryNet) ? s.statutoryNet : 0,
  };
}

/** Strip any auto-managed statutory lines from a submitted deduction set
 *  (defensive: the editor never submits them, but a stale client must not
 *  duplicate them — the server replaces them wholesale). */
export function withoutStatutoryLines(deductions: PayslipLine[]): PayslipLine[] {
  return deductions.filter((l) => !isStatutoryLineKey(l.key));
}
