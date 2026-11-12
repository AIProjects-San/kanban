// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Task 1.3 (revised): student loan
// calculator with the STC variant.
//
// Rules (IRD payroll calculations spec §5.4/§5.6/§5.9; thresholds verified
// against the IR341 monthly SL column in Phase 0):
//
//   Main employment (M SL / ME SL) — 12% of every dollar ABOVE the
//   per-period repayment threshold. The threshold is the annual $24,128
//   divided by pays-per-year and TRUNCATED to whole cents (spec §5.4:
//   weekly $464 · fortnightly $928 · four-weekly $1,856 · monthly
//   $2,010.66).
//
//   Secondary (SB SL … SA SL) — the threshold does NOT apply to secondary
//   income ("it has already been used against your main income"): 12% of
//   every dollar.
//
//   STC (IR23 tailored code) — the certificate's special rate (0–12c per
//   dollar) replaces the standard 12%. The certificate STATES whether the
//   rate applies above the threshold (main employment — spec §5.9 example
//   one: "8 cents in every dollar of earnings in excess of $464 per week")
//   or to every dollar (secondary — example three). The engine takes that
//   as stcStudentLoanThresholdApplies, defaulting to the main-employment
//   form (true). Without a certificate rate, an "STC SL" declaration
//   falls back to the standard 12% above the threshold.
//
//   ND / CAE / EDW / NSW — no student-loan variant of these codes exists
//   on the IR330; NSW borrowers are non-resident and not subject to
//   repayments (spec §5.5). Zero.
// ---------------------------------------------------------------------------

import {
  NzStatutoryError,
  parseNzTaxCode,
  periodsPerYear,
  roundMoney2,
  trunc2,
  type NzPayFrequency,
  type NzStudentLoanParam,
  type NzTaxProfileInput,
} from "./types";

/** Secondary codes whose SL variant taxes every dollar (no threshold). */
const SECONDARY_CODES = new Set(["SB", "S", "SH", "ST", "SA"]);

/**
 * The per-period repayment threshold: annualThreshold ÷ pays-per-year,
 * truncated to whole cents — the values the IR341 columns bake
 * in: weekly $464.00, fortnightly $928.00, four-weekly $1,856.00,
 * monthly $2,010.66 (= $24,128/12).
 */
export function studentLoanPeriodThreshold(
  frequency: NzPayFrequency,
  params: NzStudentLoanParam,
): number {
  return trunc2(params.annualThreshold / periodsPerYear(frequency));
}

export interface CalculateStudentLoanInput {
  gross: number;
  frequency: NzPayFrequency;
  taxProfile: NzTaxProfileInput;
  /** Rate-set student loan parameters (null = no scheme configured). */
  studentLoan?: NzStudentLoanParam | null;
}

/**
 * Student loan repayment for one pay period, 2dp. Pure. Zero when the
 * declaration carries no student loan, when the code has no SL variant,
 * or when pay is at/below the threshold.
 */
export function calculateStudentLoan(input: CalculateStudentLoanInput): number {
  const { gross, frequency, taxProfile } = input;
  const params = input.studentLoan ?? null;
  if (params == null) return 0;
  if (!Number.isFinite(gross) || gross <= 0) return 0;

  const rate = params.rate;
  const { base, studentLoan } = parseNzTaxCode(taxProfile.taxCode);

  // The loan applies when the declaration carries the SL suffix, or when
  // an STC certificate provides a special repayment rate.
  const stcRate = base === "STC" ? taxProfile.stcStudentLoanRate : null;
  if (!studentLoan && stcRate == null) return 0;

  // Codes without an SL variant on the IR330 — nothing to deduct.
  if (base === "ND" || base === "CAE" || base === "EDW" || base === "NSW") return 0;

  // Secondary income: every dollar, no threshold (IRD).
  if (SECONDARY_CODES.has(base)) {
    return roundMoney2(gross * rate);
  }

  // STC with a certificate rate: the certificate states whether the
  // threshold applies (main employment default) — spec §5.9.
  if (base === "STC" && stcRate != null) {
    if (stcRate < 0 || stcRate > 0.12) {
      throw new NzStatutoryError(
        `STC student loan rate must be within 0–0.12 (got ${stcRate})`,
      );
    }
    if (!taxProfile.stcStudentLoanThresholdApplies) {
      return roundMoney2(gross * stcRate);
    }
    const threshold = studentLoanPeriodThreshold(frequency, params);
    return roundMoney2(Math.max(0, gross - threshold) * stcRate);
  }

  // Main employment (M SL / ME SL, and the STC fallback): 12% above the
  // per-period threshold.
  const threshold = studentLoanPeriodThreshold(frequency, params);
  return roundMoney2(Math.max(0, gross - threshold) * rate);
}
