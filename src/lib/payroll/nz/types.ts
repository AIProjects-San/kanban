// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Phase 1 shared types (Tasks 1.1–1.4).
//
// The engine is PURE: every function takes explicitly-resolved parameters
// (the Phase 0 StatutoryRateSet family adapted into plain numbers) and an
// employee tax profile in the engine's own shape. Nothing here touches the
// database, the clock or the filesystem — calculate.ts holds the two
// impure seams (the DB rate-set resolver and the EmployeeTaxProfile row
// adapter) so the calculation core stays table-testable.
//
// Frequency: the house PayrollFrequency minus DAILY. IRD publishes PAYE
// tables for weekly / fortnightly / four-weekly / monthly pays; Fernly's
// cadences map WEEKLY 52 · FORTNIGHTLY 26 · BIMONTHLY 24 · MONTHLY 12, and
// the QUARTERLY/ANNUAL house extras annualise trivially (×4 / ×1). DAILY
// is rejected: IRD has no daily table — daily-paid employees are aggregated
// per pay run, which is a Phase 2 wiring concern, not a rate concern.
//
// Rounding discipline (user decision, Phase 0): every statutory line is
// rounded INDEPENDENTLY, half-up, to 2dp. Derived totals are computed from
// the rounded lines so the payslip ledger always sums (tax + acc = total,
// esct + employerNet = employerGross). The IRD printed tables truncate to
// whole dollars/cents; this engine computes on exact cents (the online
// PAYE calculator's behaviour) and reproduces the published table values
// on every verified row — see the Task 1.1 acceptance tests.
// ---------------------------------------------------------------------------

import type { PayrollFrequency } from "@/lib/payroll-windows";

/** Pay cadences the statutory engine understands (house vocabulary, no DAILY). */
export type NzPayFrequency = Exclude<PayrollFrequency, "DAILY">;

/** Pays per year for each cadence — the annualisation divisor. */
export const NZ_PERIODS_PER_YEAR: Record<NzPayFrequency, number> = {
  WEEKLY: 52,
  FORTNIGHTLY: 26,
  BIMONTHLY: 24,
  MONTHLY: 12,
  QUARTERLY: 4,
  ANNUAL: 1,
};

/** Pays per year for a cadence (52 weekly … 1 annual). */
export function periodsPerYear(frequency: NzPayFrequency): number {
  return NZ_PERIODS_PER_YEAR[frequency];
}

// ---------------------------------------------------------------------------
// Rate parameters — the Phase 0 StatutoryRateSet family as plain numbers.
// Adapted from DB rows by calculate.ts; hand-built in tests. All rates are
// decimals (0.105 = 10.5%), all bounds are annual dollar amounts.
// ---------------------------------------------------------------------------

/** Primary-code (M/ME) marginal income-tax slab on annualised income. */
export interface NzPayeTierParam {
  /** Inclusive lower bound (previous tier's toAnnual; first tier is 0). */
  fromAnnual: number;
  /** Exclusive upper bound; null = open-ended top tier. */
  toAnnual: number | null;
  /** Marginal INCOME TAX rate — the ACC levy is a separate line. */
  rate: number;
}

/** Secondary-code flat rate row. accInclusive: true = the stored rate is
 * the IR340 COMBINED deduction rate (income tax + ACC levy, e.g. SB
 * 12.25% = 10.5% + 1.75%) — the calculator puts the whole deduction in
 * the tax line and adds no levy. false (the admin-editable split form) =
 * income tax only, with the levy added as its own capped line. The seeded
 * canonical rows are combined (accInclusive: true). */
export interface NzSecondaryRateParam {
  code: string; // SB | S | SH | ST | SA | ND
  rate: number;
  accInclusive?: boolean;
}

/** ACC earners' levy — 1:1 with the rate set. */
export interface NzAccLevyParam {
  rate: number; // 0.0175 (FY2026-27)
  maxEarnings: number; // 156,641 — annual liable-earnings cap
  maxLevy: number; // 2,741.22 — published annual maximum levy
}

/** Independent Earner Tax Credit (ME code) — 1:1 with the rate set. */
export interface NzIetcParam {
  annualAmount: number; // 520
  lowerBound: number; // 24,000 — no credit below this annual income
  abateFrom: number; // 66,000 — abates above this
  upperBound: number; // 70,000 — fully abated at/above this
  abateRate: number; // 0.13 — cents abated per dollar above abateFrom
}

/** KiwiSaver scheme parameters — 1:1 with the rate set. */
export interface NzKiwiSaverParam {
  defaultEmployeeRate: number; // 0.035 — no-election default (user decision)
  allowedEmployeeRates: number[]; // percent numbers [3, 3.5, 4, 6, 8, 10]
  employerRate: number; // 0.035 — compulsory employer contribution
}

/** ESCT tier on annual (salary + gross employer contributions). */
export interface NzEsctTierParam {
  fromAnnual: number;
  toAnnual: number | null;
  rate: number;
}

/** Student loan parameters — 1:1 with the rate set. */
export interface NzStudentLoanParam {
  rate: number; // 0.12
  annualThreshold: number; // 24,128
}

/** A fully-resolved statutory rate set, ready for the pure engine. */
export interface NzRateSetParams {
  id: string;
  label: string;
  payeTiers: NzPayeTierParam[];
  secondaryRates: NzSecondaryRateParam[];
  accLevy: NzAccLevyParam;
  ietc: NzIetcParam | null;
  kiwiSaver: NzKiwiSaverParam | null;
  esctTiers: NzEsctTierParam[];
  studentLoan: NzStudentLoanParam | null;
}

// ---------------------------------------------------------------------------
// Employee tax profile — the ENGINE's view. The DB row
// (EmployeeTaxProfile) is adapted into this shape by toNzTaxProfile() in
// calculate.ts; the employment facts that KiwiSaver auto-enrolment needs
// (category, start date, holiday-pay treatment) come from the caller —
// Phase 2 wires them from the HR profile when persisting enrolment
// transitions.
// ---------------------------------------------------------------------------

/** DB election vocabulary (Phase 0 EmployeeTaxProfile.kiwiSaverStatus;
 * "NOT_ENROLLED" added in Phase 3 for the admin profile editor). */
export type NzKsElectionStatus =
  | "ACTIVE"
  | "NOT_ENROLLED"
  | "OPTED_OUT"
  | "ON_HOLIDAY"
  | "NOT_ELIGIBLE";

/**
 * KiwiSaver employment category for the auto-enrolment rules (IRD
 * "Opting in and enrolling temporary and casual employees"):
 *   PERMANENT            — auto-enrolled at hire (the ACTIVE posture)
 *   CASUAL               — irregular/intermittent; exempt while holiday pay
 *                          is paid with wages (may opt in)
 *   TEMPORARY            — 28-day rule: auto-enrol from day 29
 *   CASUAL_AGRICULTURAL  — 3-month rule: auto-enrol beyond 3 months
 */
export type NzEmploymentCategory =
  | "PERMANENT"
  | "CASUAL"
  | "TEMPORARY"
  | "CASUAL_AGRICULTURAL";

/** The engine's tax profile input (adapted, never a DB row). */
export interface NzTaxProfileInput {
  /** IR330 code, optionally " SL"-suffixed (e.g. "M SL", "SB SL"). */
  taxCode: string;
  /** True = irregular-hours casual (CAE/NSW/EDW family) — no IETC. */
  isCasual: boolean;
  /** KiwiSaver auto-enrolment category (see NzEmploymentCategory). */
  employmentCategory: NzEmploymentCategory;
  /** Employment start (hire) date — drives the 28-day / 3-month rules. */
  employmentStartDate: Date | null;
  /** Casual employee's holiday pay is paid with wages (8% on top). */
  casualHolidayPayInWages: boolean;
  /** KiwiSaver election (DB vocabulary — resolved by resolveKiwiSaverStatus). */
  kiwiSaverStatus: NzKsElectionStatus;
  /** Elected employee rate; null = rate-set default when enrolled. */
  kiwiSaverRate: number | null;
  /** Elected employer rate; null = rate-set compulsory rate. */
  employerKiwiSaverRate: number | null;
  /** Fixed ESCT rate override (engine supports it; DB field is a Phase 2 candidate). */
  esctRateOverride: number | null;
  /** IR23 tailored PAYE rate (STC only) — e.g. 0.18. */
  taxCodeSpecialRate: number | null;
  /** STC ACC treatment: "INC" rate includes the levy (IRD default) | "PLUS" add levy. */
  stcAccTreatment: "INC" | "PLUS" | null;
  /** IR23 special student-loan rate (0–12c per dollar). */
  stcStudentLoanRate: number | null;
  /**
   * IR23 certificate states whether the SL special rate applies above the
   * pay-period threshold (main employment — IRD spec §5.9 examples) or to
   * every dollar (secondary). Main-employment default: true.
   */
  stcStudentLoanThresholdApplies: boolean;
  /**
   * Phase 1A — a recorded KiwiSaver auto-enrolment EXEMPTION reason code
   * (EmployeeTaxProfile.autoEnrolExemption). Non-empty blocks the 28-day /
   * 3-month time rules from auto-enrolling (an explicit opt-in election
   * still wins). Null/empty = no exemption.
   */
  autoEnrolExemption?: string | null;
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Error thrown for unusable statutory inputs (unknown code, missing STC
 *  certificate rate, no effective rate set…). Digest-stamped so server
 *  actions can distinguish engine errors from authorisation errors. */
export class NzStatutoryError extends Error {
  readonly digest = "NzStatutoryError";
  constructor(message: string) {
    super(message);
    this.name = "NzStatutoryError";
  }
}

export interface ParsedNzTaxCode {
  /** Base code, uppercased, " SL" suffix removed ("M SL" → "M"). */
  base: string;
  /** True when the declared code carried the student-loan suffix. */
  studentLoan: boolean;
}

/** Parse an IR330 declaration into base code + student-loan flag. */
export function parseNzTaxCode(raw: string): ParsedNzTaxCode {
  const code = raw.trim();
  const m = /^(.+?)\s*SL$/i.exec(code);
  if (m && m[1].trim().length > 0) {
    return { base: m[1].trim().toUpperCase(), studentLoan: true };
  }
  return { base: code.toUpperCase(), studentLoan: false };
}

/** Truncate to whole cents toward zero (IRD's per-period threshold rule:
 *  monthly SL threshold $24,128/12 = $2,010.66, spec §5.4). */
export function trunc2(n: number): number {
  return Math.trunc((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * Decimal-faithful half-up rounding to 2dp. The house round2
 * (Math.round(n × 100) / 100) breaks on IEEE-754 noise: 175 × 0.175 is the
 * double 30.624999999999996, so the exact decimal 30.625 would round DOWN
 * to 30.62. Scaling through toPrecision(12) first strips the noise, giving
 * the decimal answer 30.63. Used for EVERY statutory line — the Phase 0
 * rounding decision ("each line independent, half-up, 2dp") is a DECIMAL
 * rule, and payslip cents must match what IRD's own decimal arithmetic
 * would print.
 */
export function roundMoney2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const scaled = Number((n * 100).toPrecision(12));
  return Math.round(scaled) / 100;
}

/** Coerce a Prisma Decimal (or number/string/null) to number|null. */
export function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
