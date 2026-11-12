// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Task 1.1 (revised): PAYE calculator with a
// separate ACC earners'-levy line and STC handling.
//
// Returns THREE values for every code: tax (income tax), acc (earners'
// levy) and total — the Phase 0 decision to store income tax and the levy
// as separate parameters, so each statutory line rounds and displays
// independently while the totals reproduce the IRD tables exactly.
//
// Method per code (IRD "Payroll calculations and business rules
// specification" §5.2–5.9, FY2026-27 rates):
//
//   M / ME (primary)  Annualise the period's gross (× periods), apply the
//                     marginal slabs to the annual figure, divide back.
//                     ME additionally credits the IETC (annual $520, 13c
//                     abatement above $66k, exhausted at $70k) into the
//                     tax line — casuals never receive it. The levy is a
//                     separate line: rate × period earnings, capped at
//                     maxEarnings / periods-in-year (algebraically the
//                     annual cap for uniform pay, and table-exact: monthly
//                     $15,000 → levy $228.43, IR341).
//   SB S SH ST SA     Flat code rate on every dollar ("before ACC
//   (secondary)       levies", IRD) PLUS the levy on top — spec §5.6:
//                     the deduction is (code rate + levy rate) × pay.
//                     A rate row marked accInclusive (Phase 3) already
//                     carries the levy (a combined rate such as the IRD
//                     lump-sum table's 12.25% SB) and adds nothing.
//   ND                No IR330 given: flat 45% plus the levy (spec §5.8:
//                     (0.45 + levy) × pay; IRD: "45% plus ACC earners'
//                     levy").
//   NSW               Recognised seasonal worker: flat SB-band rate
//                     (10.5%) plus the levy, no thresholds (spec §5.5).
//                     KiwiSaver and student loan never apply (enforced in
//                     their calculators).
//   CAE / EDW         Casual agricultural / election-day worker: flat
//                     S-band rate (17.5%) plus the levy (spec §5.7:
//                     (0.175 + levy) × pay).
//   STC               IR23 tailored code: the certificate's flat rate on
//                     every dollar. IRD certificates INCLUDE the levy in
//                     the rate (spec §5.9) — stcAccTreatment "INC" (the
//                     default) leaves acc at 0; "PLUS" adds the levy as a
//                     separate line for certificates that exclude it.
//                     No certificate rate → NzStatutoryError (no default
//                     exists).
// ---------------------------------------------------------------------------

import {
  NzStatutoryError,
  parseNzTaxCode,
  periodsPerYear,
  roundMoney2,
  type NzAccLevyParam,
  type NzIetcParam,
  type NzPayeTierParam,
  type NzPayFrequency,
  type NzSecondaryRateParam,
  type NzTaxProfileInput,
} from "./types";

/** Calculation method that produced the PAYE lines. */
export type NzPayeMethod =
  | "PRIMARY" // M / ME
  | "SECONDARY" // SB S SH ST SA
  | "ND" // no declaration
  | "NSW" // recognised seasonal worker
  | "CAE_EDW" // casual agricultural / election day
  | "STC"; // IR23 tailored code

export interface NzPayeResult {
  /** Income tax line (IETC netted in for ME), 2dp. */
  tax: number;
  /** ACC earners' levy line, 2dp. */
  acc: number;
  /** tax + acc (both lines already 2dp), 2dp. */
  total: number;
  /** Which method produced the lines. */
  method: NzPayeMethod;
  /** IETC credited through PAYE (ME only, non-casual), per period, 2dp. */
  ietc: number;
  /** Annualised gross the slabs saw (primary codes; gross otherwise). */
  annualised: number;
}

/** Secondary codes with a seeded flat rate (income tax only). */
const SECONDARY_CODES = new Set(["SB", "S", "SH", "ST", "SA"]);

/**
 * ACC earners' levy for ONE pay period: rate × period earnings, capped at
 * maxEarnings / periods-in-year. For uniform pay this equals the annual
 * computation min(gross × periods, cap) × rate / periods (the min and the
 * scaling commute), and it is the table-exact form — monthly $15,000 →
 * 1.75% × min(15,000, 156,641/12 = 13,053.4167) = $228.43, matching the
 * IR341 monthly table where the annually-capped form (2,741.22/12 =
 * $228.435 → $228.44) is one cent high.
 */
export function accLevyForPeriod(
  gross: number,
  frequency: NzPayFrequency,
  levy: NzAccLevyParam,
): number {
  const perPeriodCap = levy.maxEarnings / periodsPerYear(frequency);
  return levy.rate * Math.min(gross, perPeriodCap);
}

/**
 * Marginal slab tax on an ANNUAL amount (income tax only). Tiers are
 * cumulative [fromAnnual, toAnnual) — income exactly at a boundary gets
 * the lower rate on every dollar below it, matching IRD's inclusive
 * printed bands ("$1 to $15,600 inclusive → 10.5%").
 */
export function slabTaxAnnual(annual: number, tiers: NzPayeTierParam[]): number {
  let tax = 0;
  for (const tier of tiers) {
    const lo = tier.fromAnnual;
    const hi = tier.toAnnual ?? Number.POSITIVE_INFINITY;
    const taxable = Math.max(0, Math.min(annual, hi) - lo);
    if (taxable > 0) tax += taxable * tier.rate;
  }
  return tax;
}

/**
 * Independent Earner Tax Credit on an ANNUAL amount (spec §5.3): $0 below
 * the lower bound, the full annual amount up to abateFrom, abating at
 * abateRate per dollar above it, exhausted at upperBound.
 */
export function ietcForAnnual(annual: number, ietc: NzIetcParam): number {
  if (annual < ietc.lowerBound || annual >= ietc.upperBound) return 0;
  if (annual <= ietc.abateFrom) return ietc.annualAmount;
  return Math.max(0, ietc.annualAmount - (annual - ietc.abateFrom) * ietc.abateRate);
}

/** Find a seeded secondary rate row by code (rate + the Phase 3
 * accInclusive combined-rate flag). */
function secondaryRateRowFor(
  code: string,
  secondaryRates: NzSecondaryRateParam[],
): NzSecondaryRateParam | null {
  return secondaryRates.find((s) => s.code === code) ?? null;
}

/** Levy line for a flat-rate code: the per-period levy, or 0 when the rate
 * row itself already includes it (combined rate — Phase 3). */
function levyForRateRow(
  gross: number,
  frequency: NzPayFrequency,
  levy: NzAccLevyParam,
  row: NzSecondaryRateParam,
): number {
  if (row.accInclusive) return 0;
  return roundMoney2(accLevyForPeriod(gross, frequency, levy));
}

export interface CalculatePayeInput {
  gross: number;
  frequency: NzPayFrequency;
  taxProfile: NzTaxProfileInput;
  payeTiers: NzPayeTierParam[];
  secondaryRates: NzSecondaryRateParam[];
  accLevy: NzAccLevyParam;
  ietc: NzIetcParam | null;
}

/**
 * PAYE for one pay period: the { tax, acc, total } triple plus method
 * detail. Pure — every parameter is passed in, nothing is read from the
 * database or the environment.
 */
export function calculatePaye(input: CalculatePayeInput): NzPayeResult {
  const { gross, frequency, taxProfile } = input;
  if (!Number.isFinite(gross) || gross < 0) {
    throw new NzStatutoryError(`Gross must be a finite non-negative amount (got ${gross})`);
  }

  const { base } = parseNzTaxCode(taxProfile.taxCode);

  // ---- STC: IR23 tailored rate on every dollar (Task 1.1-r1 spec) ----
  if (base === "STC") {
    if (taxProfile.taxCodeSpecialRate == null) {
      throw new NzStatutoryError(
        "STC tax code requires a tailored rate from the IR23 certificate — no default exists",
      );
    }
    const rate = taxProfile.taxCodeSpecialRate;
    if (rate < 0 || rate > 1) {
      throw new NzStatutoryError(
        `STC tailored rate must be within 0–1 (got ${rate})`,
      );
    }
    const tax = roundMoney2(gross * rate);
    // IRD certificates include the levy in the tailored rate ("This amount
    // includes earner's levy", spec §5.9) — "INC" is the default. "PLUS"
    // is for certificates that state the rate excludes it.
    const acc =
      taxProfile.stcAccTreatment === "PLUS"
        ? roundMoney2(accLevyForPeriod(gross, frequency, input.accLevy))
        : 0;
    return { tax, acc, total: roundMoney2(tax + acc), method: "STC", ietc: 0, annualised: gross };
  }

  // ---- ND: no IR330 — flat 45% plus the levy (spec §5.8) ----
  if (base === "ND") {
    const row = secondaryRateRowFor("ND", input.secondaryRates);
    if (row == null) {
      throw new NzStatutoryError("No ND rate seeded in the secondary-rate table");
    }
    const tax = roundMoney2(gross * row.rate);
    const acc = levyForRateRow(gross, frequency, input.accLevy, row);
    return { tax, acc, total: roundMoney2(tax + acc), method: "ND", ietc: 0, annualised: gross };
  }

  // ---- NSW: recognised seasonal worker — SB-band flat rate plus the
  //      levy, no thresholds (spec §5.5: (0.105 + levy) × pay) ----
  if (base === "NSW") {
    const row = secondaryRateRowFor("SB", input.secondaryRates);
    if (row == null) {
      throw new NzStatutoryError("No SB rate seeded for the NSW calculation");
    }
    const tax = roundMoney2(gross * row.rate);
    const acc = levyForRateRow(gross, frequency, input.accLevy, row);
    return { tax, acc, total: roundMoney2(tax + acc), method: "NSW", ietc: 0, annualised: gross };
  }

  // ---- CAE / EDW: casual agricultural / election day — S-band flat rate
  //      plus the levy (spec §5.7: (0.175 + levy) × pay) ----
  if (base === "CAE" || base === "EDW") {
    const row = secondaryRateRowFor("S", input.secondaryRates);
    if (row == null) {
      throw new NzStatutoryError("No S rate seeded for the CAE/EDW calculation");
    }
    const tax = roundMoney2(gross * row.rate);
    const acc = levyForRateRow(gross, frequency, input.accLevy, row);
    return { tax, acc, total: roundMoney2(tax + acc), method: "CAE_EDW", ietc: 0, annualised: gross };
  }

  // ---- Secondary codes: flat rate on every dollar + levy (spec §5.6) ----
  if (SECONDARY_CODES.has(base)) {
    const row = secondaryRateRowFor(base, input.secondaryRates);
    if (row == null) {
      throw new NzStatutoryError(`No ${base} rate seeded in the secondary-rate table`);
    }
    const tax = roundMoney2(gross * row.rate);
    const acc = levyForRateRow(gross, frequency, input.accLevy, row);
    return { tax, acc, total: roundMoney2(tax + acc), method: "SECONDARY", ietc: 0, annualised: gross };
  }

  // ---- Primary M / ME: annualise → slabs → per period (spec §5.2/5.3) ----
  if (base === "M" || base === "ME") {
    const ppy = periodsPerYear(frequency);
    const annual = gross * ppy;
    const taxAnnual = slabTaxAnnual(annual, input.payeTiers);
    // IETC rides the ME code only, and never for casual employment (the
    // engine's casual path taxes each payment on its own annualisation
    // without the credit — Phase 0 schema contract).
    const ietcAnnual =
      base === "ME" && !taxProfile.isCasual && input.ietc
        ? ietcForAnnual(annual, input.ietc)
        : 0;
    const tax = roundMoney2((taxAnnual - ietcAnnual) / ppy);
    const acc = roundMoney2(accLevyForPeriod(gross, frequency, input.accLevy));
    return {
      tax,
      acc,
      total: roundMoney2(tax + acc),
      method: "PRIMARY",
      ietc: roundMoney2(ietcAnnual / ppy),
      annualised: annual,
    };
  }

  throw new NzStatutoryError(
    `Unsupported tax code "${base}" — the IR330 vocabulary is M, ME, SB, S, SH, ST, SA, ND, STC, CAE, NSW, EDW (optionally " SL"-suffixed)`,
  );
}
