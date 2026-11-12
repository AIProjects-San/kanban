// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Task 1.4 (revised): the aggregator.
//
// calculateNzStatutoryWithSet — the PURE core: takes a fully-resolved rate
// set (NzRateSetParams) and an engine tax profile, runs the Task 1.1–1.3
// calculators and returns the NzStatutoryResult the payroll run will
// snapshot onto payslips (Phase 2 wires PayrollRun.rateSetId +
// Payslip.statutory).
//
// calculateNzStatutory — the async entry point: resolves the effective
// StatutoryRateSet for the pay period (explicit rateSetId, or the latest
// set whose [effectiveFrom, effectiveTo) window contains payPeriodEnd)
// and delegates. The two impure seams live here and only here:
//
//   resolveNzRateSet(at, explicitId?) — the DB resolver
//   toNzTaxProfile(row, employment?)  — the EmployeeTaxProfile row adapter
//
// The employment facts KiwiSaver auto-enrolment needs (category, start
// date, holiday-pay treatment) are not Phase 0 profile fields — Phase 2
// supplies them from the HR profile when it wires the run, and persists
// triggered enrolments (with an audit entry) per the Task 1.2 design.
//
// netPay = gross − PAYE total − employee KiwiSaver − student loan.
// Employer contributions and ESCT are employer-side money and never
// reduce net pay.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { calculatePaye } from "./paye";
import {
  calculateKiwiSaver,
  resolveKiwiSaverDecision,
  type NzKsResolution,
} from "./kiwisaver";
import { calculateStudentLoan } from "./student-loan";
import {
  NzStatutoryError,
  roundMoney2,
  toNumOrNull,
  type NzEmploymentCategory,
  type NzPayFrequency,
  type NzRateSetParams,
  type NzTaxProfileInput,
} from "./types";

/** The employment-category vocabulary (mirrors NzEmploymentCategory). */
const EMPLOYMENT_CATEGORIES = new Set([
  "PERMANENT",
  "CASUAL",
  "TEMPORARY",
  "CASUAL_AGRICULTURAL",
]);

function isNzEmploymentCategory(v: unknown): v is NzEmploymentCategory {
  return typeof v === "string" && EMPLOYMENT_CATEGORIES.has(v);
}

// ---------------------------------------------------------------------------
// Result shape.
// ---------------------------------------------------------------------------

export interface NzStatutoryResult {
  gross: number;
  frequency: NzPayFrequency;
  payPeriodEnd: Date;
  paye: {
    tax: number;
    acc: number;
    total: number;
    method: string;
    /** IETC credited through the tax line (ME only). */
    ietc: number;
    /** Annualised gross the slabs saw (primary codes). */
    annualised: number;
  };
  kiwisaver: {
    status: string;
    autoEnrolTriggered: boolean;
    reason: string;
    employee: number;
    employerGross: number;
    esct: number;
    employerNet: number;
    employeeRate: number;
    employerRate: number;
    esctRate: number;
  };
  studentLoan: number;
  /** gross − paye.total − kiwisaver.employee − studentLoan. */
  netPay: number;
  /** The declared IR330 code, as written on the profile. */
  taxCodeApplied: string;
  /** Which rate set produced the numbers. */
  rateSet: { id: string; label: string };
  /** Content hash of every rate the calculation consumed (see nzRuleVersion). */
  ruleVersion: string;
}

// ---------------------------------------------------------------------------
// Rule version — a content hash over every parameter the calculation
// consumed, EXCLUDING the set's identity. Two sets with identical values
// hash identically; one changed tier changes the hash. Stored on payslip
// snapshots so a computed line can always be re-derived and audited.
// ---------------------------------------------------------------------------

export function nzRuleVersion(set: NzRateSetParams): string {
  const canonical = JSON.stringify({
    paye: [...set.payeTiers]
      .sort((a, b) => a.fromAnnual - b.fromAnnual)
      .map((t) => [t.fromAnnual, t.toAnnual, t.rate]),
    secondary: [...set.secondaryRates]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((s) => [s.code, s.rate]),
    acc: [set.accLevy.rate, set.accLevy.maxEarnings, set.accLevy.maxLevy],
    ietc: set.ietc
      ? [set.ietc.annualAmount, set.ietc.lowerBound, set.ietc.abateFrom, set.ietc.upperBound, set.ietc.abateRate]
      : null,
    kiwiSaver: set.kiwiSaver
      ? [set.kiwiSaver.defaultEmployeeRate, set.kiwiSaver.allowedEmployeeRates, set.kiwiSaver.employerRate]
      : null,
    esct: [...set.esctTiers]
      .sort((a, b) => a.fromAnnual - b.fromAnnual)
      .map((t) => [t.fromAnnual, t.toAnnual, t.rate]),
    studentLoan: set.studentLoan ? [set.studentLoan.rate, set.studentLoan.annualThreshold] : null,
  });
  // FNV-1a 32-bit — deterministic, dependency-free, isomorphic.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `nz1:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Pure core.
// ---------------------------------------------------------------------------

export interface CalculateNzStatutoryInput {
  gross: number;
  frequency: NzPayFrequency;
  taxProfile: NzTaxProfileInput;
  payPeriodEnd: Date;
  rateSet: NzRateSetParams;
}

/** The full statutory calculation against a resolved rate set. Pure. */
export function calculateNzStatutoryWithSet(input: CalculateNzStatutoryInput): NzStatutoryResult {
  const { gross, frequency, taxProfile, payPeriodEnd, rateSet } = input;
  if (!Number.isFinite(gross) || gross < 0) {
    throw new NzStatutoryError(`Gross must be a finite non-negative amount (got ${gross})`);
  }

  const paye = calculatePaye({
    gross,
    frequency,
    taxProfile,
    payeTiers: rateSet.payeTiers,
    secondaryRates: rateSet.secondaryRates,
    accLevy: rateSet.accLevy,
    ietc: rateSet.ietc,
  });

  const ksResolution: NzKsResolution = resolveKiwiSaverDecision(taxProfile, payPeriodEnd);
  const kiwisaver = calculateKiwiSaver({
    gross,
    frequency,
    taxProfile,
    resolution: ksResolution,
    kiwiSaver: rateSet.kiwiSaver,
    esctTiers: rateSet.esctTiers,
  });

  const studentLoan = calculateStudentLoan({
    gross,
    frequency,
    taxProfile,
    studentLoan: rateSet.studentLoan,
  });

  const netPay = roundMoney2(gross - paye.total - kiwisaver.employee - studentLoan);

  return {
    gross,
    frequency,
    payPeriodEnd,
    paye: {
      tax: paye.tax,
      acc: paye.acc,
      total: paye.total,
      method: paye.method,
      ietc: paye.ietc,
      annualised: paye.annualised,
    },
    kiwisaver,
    studentLoan,
    netPay,
    taxCodeApplied: taxProfile.taxCode.trim(),
    rateSet: { id: rateSet.id, label: rateSet.label },
    ruleVersion: nzRuleVersion(rateSet),
  };
}

// ---------------------------------------------------------------------------
// EmployeeTaxProfile row adapter (impure seam #1).
// ---------------------------------------------------------------------------

/** Structural slice of the Prisma EmployeeTaxProfile row this adapter needs. */
export interface NzTaxProfileRow {
  taxCode: string;
  isCasual: boolean;
  kiwiSaverStatus: string;
  /** Prisma Decimal | null. */
  kiwiSaverEmployeeRate: unknown;
  /** Prisma Decimal | null. */
  kiwiSaverEmployerRate: unknown;
  /** Prisma Decimal | null. */
  taxCodeSpecialRate: unknown;
  stcAccTreatment: string | null;
  /** Prisma Decimal | null. */
  stcStudentLoanRate: unknown;
  // --- Phase 1A: the explicit SL declaration box (OR'd with the code
  // suffix) and the recorded auto-enrolment exemption. ---
  /** True = the IR330 student-loan box was ticked (OR's " SL" onto the
   *  code when the suffix is missing). */
  studentLoan?: boolean | null;
  /** Non-empty = a recorded auto-enrolment exemption reason code. */
  autoEnrolExemption?: string | null;
  // --- Phase 3 (Task 3.4-r1): employment facts live on the profile row
  // itself. Each is optional so pre-migration callers still work; when set
  // they take precedence over the employment parameter. ---
  /** PERMANENT | CASUAL | TEMPORARY | CASUAL_AGRICULTURAL (null = derive
   *  from isCasual, the Phase 0/1 behaviour). */
  employmentType?: string | null;
  /** Casual holiday pay paid with wages (8% on top). */
  casualHolidayPayInWages?: boolean | null;
  /** Employment start (hire) date. */
  employmentStartDate?: Date | null;
  /** Fixed ESCT rate override (IR23/employer election). */
  esctRateOverride?: unknown;
}

/** Employment facts KiwiSaver auto-enrolment needs (Phase 2 supplies them). */
export interface NzEmploymentFacts {
  /** Hire date — the 28-day / 3-month rules count from here. */
  hireDate?: Date | null;
  /** Overrides the isCasual-derived category when the caller knows better
   *  (TEMPORARY / CASUAL_AGRICULTURAL are not derivable from the Phase 0
   *  profile). */
  employmentCategory?: NzEmploymentCategory;
  /** Casual holiday pay paid with wages (8% on top). Defaults true — the
   *  typical NZ casual arrangement, and the conservative no-deduction
   *  posture for a casual without a recorded fact. */
  casualHolidayPayInWages?: boolean;
}

const KS_ELECTIONS = new Set([
  "ACTIVE",
  "NOT_ENROLLED", // Phase 3 — admin-recorded "not in the scheme"
  "OPTED_OUT",
  "ON_HOLIDAY",
  "NOT_ELIGIBLE",
]);

/** Adapt a DB EmployeeTaxProfile row (+ optional employment facts) into the
 *  engine's NzTaxProfileInput. */
export function toNzTaxProfile(
  row: NzTaxProfileRow,
  employment: NzEmploymentFacts = {},
): NzTaxProfileInput {
  const status = row.kiwiSaverStatus;
  if (!KS_ELECTIONS.has(status)) {
    throw new NzStatutoryError(
      `Unknown KiwiSaver election "${status}" — the vocabulary is ACTIVE, NOT_ENROLLED, OPTED_OUT, ON_HOLIDAY, NOT_ELIGIBLE`,
    );
  }
  const taxCode = row.taxCode.trim();
  if (!taxCode) {
    throw new NzStatutoryError("EmployeeTaxProfile has an empty tax code");
  }
  const accTreatment = row.stcAccTreatment == null ? null : row.stcAccTreatment.toUpperCase();
  if (accTreatment != null && accTreatment !== "INC" && accTreatment !== "PLUS") {
    throw new NzStatutoryError(
      `Unknown STC ACC treatment "${row.stcAccTreatment}" — the vocabulary is INC | PLUS`,
    );
  }

  // Phase 3 — employment facts from the profile row (Task 3.4-r1) win over
  // the call-site parameter; the parameter stays as the fallback for
  // pre-migration callers.
  const rowCategory = isNzEmploymentCategory(row.employmentType)
    ? (row.employmentType as NzEmploymentCategory)
    : null;
  const employmentCategory =
    rowCategory ?? employment.employmentCategory ?? (row.isCasual ? "CASUAL" : "PERMANENT");

  // Phase 1A — the explicit SL declaration box ORs " SL" onto the code
  // (the suffix stays the engine's single source; a code that already
  // carries it is left alone).
  const slDeclared = row.studentLoan === true;
  const codeWithSl =
    slDeclared && !/\s*SL$/i.test(taxCode) && !/(ND|CAE|EDW|NSW)/i.test(taxCode)
      ? `${taxCode} SL`
      : taxCode;

  return {
    taxCode: codeWithSl,
    isCasual: row.isCasual,
    employmentCategory,
    employmentStartDate: row.employmentStartDate ?? employment.hireDate ?? null,
    casualHolidayPayInWages:
      row.casualHolidayPayInWages ?? employment.casualHolidayPayInWages ?? true,
    kiwiSaverStatus: status as NzTaxProfileInput["kiwiSaverStatus"],
    kiwiSaverRate: toNumOrNull(row.kiwiSaverEmployeeRate),
    employerKiwiSaverRate: toNumOrNull(row.kiwiSaverEmployerRate),
    // Phase 3 — the DB column finally exists (Task 3.4-r1); the engine has
    // honoured the override since Phase 1.
    esctRateOverride: toNumOrNull(row.esctRateOverride),
    taxCodeSpecialRate: toNumOrNull(row.taxCodeSpecialRate),
    stcAccTreatment: accTreatment ?? "INC",
    stcStudentLoanRate: toNumOrNull(row.stcStudentLoanRate),
    // IR23 main-employment default (spec §5.9 example one); a certificate
    // that states secondary treatment flips this — Phase 2 schema candidate.
    stcStudentLoanThresholdApplies: true,
    // Phase 1A — a recorded exemption blocks the auto-enrolment time rules.
    autoEnrolExemption: row.autoEnrolExemption || null,
  };
}

// ---------------------------------------------------------------------------
// Rate-set resolver (impure seam #2).
// ---------------------------------------------------------------------------

/** Structural slice of the Prisma StatutoryRateSet row (with children). */
interface NzRateSetRow {
  id: string;
  label: string;
  payeTiers: Array<{ fromAnnual: number; toAnnual: number | null; rate: number }>;
  // Phase 3 — rows may carry the combined-rate flag (omitted = false).
  secondaryRates: Array<{ code: string; rate: number; accInclusive?: boolean }>;
  accLevy: { rate: number; maxEarnings: number; maxLevy: number } | null;
  ietc: {
    annualAmount: number;
    lowerBound: number;
    abateFrom: number;
    upperBound: number;
    abateRate: number;
  } | null;
  kiwiSaver: {
    defaultEmployeeRate: number;
    allowedEmployeeRates: unknown;
    employerRate: number;
  } | null;
  esctTiers: Array<{ fromAnnual: number; toAnnual: number | null; rate: number }>;
  studentLoan: { rate: number; annualThreshold: number } | null;
}

function mapRateSetRow(row: NzRateSetRow): NzRateSetParams {
  if (!row.accLevy) {
    throw new NzStatutoryError(
      `Rate set "${row.label}" has no ACC earners' levy parameters — unusable`,
    );
  }
  if (row.payeTiers.length === 0) {
    throw new NzStatutoryError(
      `Rate set "${row.label}" has no PAYE tiers — unusable`,
    );
  }
  return {
    id: row.id,
    label: row.label,
    payeTiers: [...row.payeTiers].sort((a, b) => a.fromAnnual - b.fromAnnual),
    secondaryRates: row.secondaryRates,
    accLevy: row.accLevy,
    ietc: row.ietc,
    kiwiSaver: row.kiwiSaver
      ? {
          defaultEmployeeRate: row.kiwiSaver.defaultEmployeeRate,
          allowedEmployeeRates: Array.isArray(row.kiwiSaver.allowedEmployeeRates)
            ? (row.kiwiSaver.allowedEmployeeRates as number[])
            : [],
          employerRate: row.kiwiSaver.employerRate,
        }
      : null,
    esctTiers: [...row.esctTiers].sort((a, b) => a.fromAnnual - b.fromAnnual),
    studentLoan: row.studentLoan,
  };
}

const RATE_SET_INCLUDE = {
  payeTiers: { orderBy: { fromAnnual: "asc" as const } },
  secondaryRates: true,
  accLevy: true,
  ietc: true,
  kiwiSaver: true,
  esctTiers: { orderBy: { fromAnnual: "asc" as const } },
  studentLoan: true,
} as const;

/**
 * Resolve the statutory rate set covering `at`: the explicit set when
 * rateSetId is given, otherwise the latest set whose half-open
 * [effectiveFrom, effectiveTo) window contains the date. Null when nothing
 * covers the date.
 */
export async function resolveNzRateSet(
  at: Date,
  explicitId?: string,
): Promise<NzRateSetParams | null> {
  const row = explicitId
    ? await db.statutoryRule.findUnique({
        where: { id: explicitId },
        include: RATE_SET_INCLUDE,
      })
    : await db.statutoryRule.findFirst({
        where: {
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        orderBy: { effectiveFrom: "desc" },
        include: RATE_SET_INCLUDE,
      });
  return row ? mapRateSetRow(row) : null;
}

// ---------------------------------------------------------------------------
// Async entry point.
// ---------------------------------------------------------------------------

export interface CalculateNzStatutoryDbInput {
  gross: number;
  frequency: NzPayFrequency;
  /** Engine profile — use toNzTaxProfile(row, employment) to build one. */
  taxProfile: NzTaxProfileInput;
  payPeriodEnd: Date;
  /** Explicit set id (PayrollRun.rateSetId); omitted = resolve by period. */
  rateSetId?: string;
}

/**
 * Full statutory calculation for one employee-period: resolves the
 * effective rate set from the database and runs the pure core. Throws
 * NzStatutoryError when no set covers the pay period.
 */
export async function calculateNzStatutory(
  input: CalculateNzStatutoryDbInput,
): Promise<NzStatutoryResult> {
  const rateSet = await resolveNzRateSet(input.payPeriodEnd, input.rateSetId);
  if (!rateSet) {
    throw new NzStatutoryError(
      `No statutory rate set effective on ${input.payPeriodEnd.toISOString().slice(0, 10)}${input.rateSetId ? ` (id ${input.rateSetId})` : ""}`,
    );
  }
  return calculateNzStatutoryWithSet({ ...input, rateSet });
}
