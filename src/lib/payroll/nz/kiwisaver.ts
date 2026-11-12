// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Task 1.2 (revised): KiwiSaver calculator
// with casual/temporary auto-enrolment logic.
//
// Two pure functions, per the user's design:
//
//   resolveKiwiSaverStatus(profile, payPeriodEnd) — the STATUS TRANSITION
//   check, never a calculation. Maps the DB election vocabulary (Phase 0:
//   ACTIVE / OPTED_OUT / ON_HOLIDAY / NOT_ELIGIBLE) onto the engine's
//   effective statuses and applies IRD's auto-enrolment exemptions
//   ("Opting in and enrolling temporary and casual employees", verified
//   2026-11-12):
//
//     • Casual employees "engaged on an irregular and intermittent basis"
//       who "get holiday pay with their wages" are EXEMPT from automatic
//       enrolment (NOT_ENROLLED; may opt in). A casual without the
//       holiday-pay-in-wages condition does not meet the statutory
//       definition, so auto-enrolment applies.
//     • Temporary employees: "You must automatically enrol employees if
//       their employment is for more than 28 days in a row. This applies
//       from day 29." The 28 days is the PERIOD OF EMPLOYMENT, not days
//       worked.
//     • Casual agricultural workers "on a day-to-day basis for fewer than
//       3 months" are exempt; beyond 3 months they must be enrolled.
//     • NSW (recognised seasonal workers) are not eligible for KiwiSaver
//       at all (non-resident).
//     • Opt-in overrides every exemption (design decision #2): an explicit
//       rate election on an ACTIVE (or NOT_ELIGIBLE under-18/65+) profile
//       is a member.
//
//   When the resolution returns ENROLLED with autoEnrolTriggered=true,
//   the PAYROLL ACTION (Phase 2) must persist the status change on
//   EmployeeTaxProfile with an audit log entry — the enrolment should be
//   persisted by writing the default rate as the explicit election, which
//   makes the transition sticky (the time rules never re-trigger).
//
//   calculateKiwiSaver({...}) — the money. Employee deduction, gross
//   employer contribution, ESCT (banded on annual salary + gross employer
//   contributions, ITA 2007 YA 1 "estimate" method) and the net employer
//   contribution. ON_HOLIDAY (savings suspension): employee 0%, employer
//   continues. Under-18/65+ members: employer contributions are voluntary
//   (spec §4.3.2) — only an explicitly elected employer rate applies.
// ---------------------------------------------------------------------------

import {
  parseNzTaxCode,
  periodsPerYear,
  roundMoney2,
  type NzEsctTierParam,
  type NzKiwiSaverParam,
  type NzPayFrequency,
  type NzTaxProfileInput,
} from "./types";

/** Effective KiwiSaver status after the auto-enrolment check. */
export type NzKsStatus =
  | "ENROLLED" // contributing (elected or default rate)
  | "NOT_ENROLLED" // exempt / pre-trigger — no deductions
  | "OPT_OUT" // opted out — nothing deducted
  | "ON_HOLIDAY" // savings suspension — employee 0%, employer continues
  | "NOT_ELIGIBLE"; // under-18/65+ without an election, or NSW

export interface NzKsResolution {
  status: NzKsStatus;
  /** True when a time rule (28-day / 3-month) enrolment fired THIS period —
   *  the Phase 2 payroll action must persist it with an audit entry. */
  autoEnrolTriggered: boolean;
  /** Human-readable basis — goes into the audit trail / payslip detail. */
  reason: string;
}

/** Whole days between two dates (both normalised to UTC midnight). */
function diffInDays(later: Date, earlier: Date): number {
  const a = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  const b = Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

/** Shift a date by whole calendar months, clamping the day to the target
 *  month's length (Jan 31 + 1 month → Feb 28/29 — date-fns semantics). */
function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), daysInTarget)),
  );
}

/** True when `end` is strictly beyond `start` + wholeMonths (so 3 months
 *  and one day counts as "more than 3 months", which an integer month
 *  difference alone would miss). */
function exceedsWholeMonths(end: Date, start: Date, wholeMonths: number): boolean {
  return end.getTime() > addMonthsClamped(start, wholeMonths).getTime();
}

/**
 * Resolve the effective KiwiSaver status for a pay period. Pure; the
 * employment facts arrive on the profile (Phase 2 wires them from the HR
 * profile when it persists enrolment transitions).
 */
export function resolveKiwiSaverStatus(
  taxProfile: NzTaxProfileInput,
  payPeriodEnd: Date,
): NzKsResolution {
  const { base } = parseNzTaxCode(taxProfile.taxCode);

  // Non-resident seasonal workers cannot join KiwiSaver (spec §5.5).
  if (base === "NSW") {
    return {
      status: "NOT_ELIGIBLE",
      autoEnrolTriggered: false,
      reason: "NSW (recognised seasonal worker) — not eligible for KiwiSaver",
    };
  }

  switch (taxProfile.kiwiSaverStatus) {
    case "OPTED_OUT":
      return {
        status: "OPT_OUT",
        autoEnrolTriggered: false,
        reason: "Employee opted out — no employee deduction, no employer contribution",
      };

    case "ON_HOLIDAY":
      return {
        status: "ON_HOLIDAY",
        autoEnrolTriggered: false,
        reason: "Savings suspension — employee 0%, employer contribution continues",
      };

    case "NOT_ELIGIBLE":
      // Under-18 / 65+ members joined by opting in through a provider or a
      // KS2 — an explicit rate election is the evidence. Employer
      // contributions stay voluntary for them (spec §4.3.2).
      if (taxProfile.kiwiSaverRate != null) {
        return {
          status: "ENROLLED",
          autoEnrolTriggered: false,
          reason: "Under-18/65+ member who opted in (explicit election) — employer contribution voluntary",
        };
      }
      return {
        status: "NOT_ELIGIBLE",
        autoEnrolTriggered: false,
        reason: "Under-18/65+ without an election — no employee deduction, no compulsory employer contribution",
      };
  }

  // ACTIVE — in the scheme unless an exemption category applies. An
  // explicit rate election always means member (opt-in, or an enrolment
  // persisted by a previous run).
  if (taxProfile.kiwiSaverRate != null) {
    return {
      status: "ENROLLED",
      autoEnrolTriggered: false,
      reason: "Explicit rate election on record — member (opt-in or persisted enrolment)",
    };
  }

  switch (taxProfile.employmentCategory) {
    // Casual: exempt while holiday pay is paid with the wages (the IRD
    // definition — irregular/intermittent AND holiday pay in wages).
    case "CASUAL":
      if (taxProfile.casualHolidayPayInWages) {
        return {
          status: "NOT_ENROLLED",
          autoEnrolTriggered: false,
          reason: "Casual (irregular/intermittent, holiday pay in wages) — exempt from automatic enrolment; may opt in",
        };
      }
      return {
        status: "ENROLLED",
        autoEnrolTriggered: true,
        reason: "Casual without the holiday-pay-in-wages condition — does not meet the statutory exemption, auto-enrolled",
      };

    // Temporary: auto-enrol from day 29 of continuous employment.
    case "TEMPORARY": {
      if (!taxProfile.employmentStartDate) {
        return {
          status: "NOT_ENROLLED",
          autoEnrolTriggered: false,
          reason: "Temporary employment — no start date on record, the 28-day rule cannot trigger",
        };
      }
      const days = diffInDays(payPeriodEnd, taxProfile.employmentStartDate);
      if (days > 28) {
        return {
          status: "ENROLLED",
          autoEnrolTriggered: true,
          reason: `Temporary employment reached day ${days} (> 28 days in a row) — auto-enrolled from day 29`,
        };
      }
      return {
        status: "NOT_ENROLLED",
        autoEnrolTriggered: false,
        reason: `Temporary employment — day ${days} of 28; auto-enrolment triggers on day 29`,
      };
    }

    // Casual agricultural: exempt on a day-to-day basis for under 3 months.
    case "CASUAL_AGRICULTURAL": {
      if (!taxProfile.employmentStartDate) {
        return {
          status: "NOT_ENROLLED",
          autoEnrolTriggered: false,
          reason: "Casual agricultural employment — no start date on record, the 3-month rule cannot trigger",
        };
      }
      if (exceedsWholeMonths(payPeriodEnd, taxProfile.employmentStartDate, 3)) {
        return {
          status: "ENROLLED",
          autoEnrolTriggered: true,
          reason: "Casual agricultural employment passed 3 months — auto-enrolled",
        };
      }
      return {
        status: "NOT_ENROLLED",
        autoEnrolTriggered: false,
        reason: "Casual agricultural employment — within 3 months; exempt while day-to-day",
      };
    }

    // Permanent (and any unclassified category): the ACTIVE posture is
    // auto-enrolment at hire — contributing at the rate-set default until
    // an election or opt-out is recorded (user decision: 3.5% FY2026-27).
    default:
      return {
        status: "ENROLLED",
        autoEnrolTriggered: false,
        reason: "Permanent employment — auto-enrolled at hire (ACTIVE, default rate until an election is recorded)",
      };
  }
}

/**
 * ESCT tier rate for an annual salary-plus-employer-contributions amount.
 * Upper bounds are INCLUSIVE per IRD's Table 1 ("$1 – $18,720 → 10.5%"),
 * unlike the cumulative PAYE slabs where the boundary falls out of the
 * accumulation.
 */
export function esctRateForAnnual(annual: number, tiers: NzEsctTierParam[]): number {
  for (const tier of tiers) {
    if (annual <= (tier.toAnnual ?? Number.POSITIVE_INFINITY)) return tier.rate;
  }
  return 0;
}

export interface NzKiwiSaverResult {
  status: NzKsStatus;
  autoEnrolTriggered: boolean;
  reason: string;
  /** Employee deduction, 2dp (0 unless enrolled). */
  employee: number;
  /** Gross employer contribution, 2dp. */
  employerGross: number;
  /** ESCT withheld from the employer contribution, 2dp. */
  esct: number;
  /** employerGross − esct, 2dp (the amount that reaches the scheme). */
  employerNet: number;
  /** Effective employee rate applied (0 when not contributing). */
  employeeRate: number;
  /** Effective employer rate applied. */
  employerRate: number;
  /** ESCT rate applied to the employer contribution. */
  esctRate: number;
}

export interface CalculateKiwiSaverInput {
  gross: number;
  frequency: NzPayFrequency;
  taxProfile: NzTaxProfileInput;
  /** From resolveKiwiSaverStatus for the same profile + period. */
  resolution: NzKsResolution;
  /** Rate-set KiwiSaver parameters (null = no scheme configured). */
  kiwiSaver: NzKiwiSaverParam | null;
  esctTiers: NzEsctTierParam[];
}

/**
 * KiwiSaver money for one pay period. Pure. Line discipline: esct is
 * rounded from its exact product, then employerNet = employerGross − the
 * ROUNDED esct, so esct + employerNet always equals employerGross.
 */
export function calculateKiwiSaver(input: CalculateKiwiSaverInput): NzKiwiSaverResult {
  const { gross, frequency, taxProfile, resolution, kiwiSaver } = input;
  const zero: NzKiwiSaverResult = {
    status: resolution.status,
    autoEnrolTriggered: resolution.autoEnrolTriggered,
    reason: resolution.reason,
    employee: 0,
    employerGross: 0,
    esct: 0,
    employerNet: 0,
    employeeRate: 0,
    employerRate: 0,
    esctRate: 0,
  };

  if (resolution.status === "NOT_ENROLLED" || resolution.status === "OPT_OUT") {
    return zero;
  }
  if (resolution.status === "NOT_ELIGIBLE") {
    return zero;
  }
  if (!kiwiSaver) {
    return { ...zero, reason: `${resolution.reason} — no KiwiSaver parameters in the rate set` };
  }

  // Savings suspension: the employee line is 0, the employer line (and its
  // ESCT) continues.
  const employeeRate =
    resolution.status === "ON_HOLIDAY" ? 0 : (taxProfile.kiwiSaverRate ?? kiwiSaver.defaultEmployeeRate);

  // Under-18/65+ members: employer contributions are voluntary — only an
  // explicitly elected employer rate applies (spec §4.3.2).
  const employerRate =
    taxProfile.employerKiwiSaverRate ??
    (taxProfile.kiwiSaverStatus === "NOT_ELIGIBLE" ? 0 : kiwiSaver.employerRate);

  const employee = roundMoney2(gross * employeeRate);
  const employerGross = roundMoney2(gross * employerRate);

  // ESCT bands on annual salary + GROSS employer contributions (ITA 2007
  // YA 1 — the estimate method for anyone not employed the whole previous
  // year). A fixed override wins when present.
  const annualForEsct = (gross + employerGross) * periodsPerYear(frequency);
  const esctRate =
    taxProfile.esctRateOverride ?? esctRateForAnnual(annualForEsct, input.esctTiers);
  const esct = roundMoney2(employerGross * esctRate);
  const employerNet = roundMoney2(employerGross - esct);

  return {
    status: resolution.status,
    autoEnrolTriggered: resolution.autoEnrolTriggered,
    reason: resolution.reason,
    employee,
    employerGross,
    esct,
    employerNet,
    employeeRate,
    employerRate,
    esctRate,
  };
}

/**
 * Convenience: resolve + calculate in one step (the aggregator calls the
 * two functions directly so it can inspect the resolution independently).
 */
export function resolveAndCalculateKiwiSaver(
  input: Omit<CalculateKiwiSaverInput, "resolution"> & { payPeriodEnd: Date },
): NzKiwiSaverResult {
  const resolution = resolveKiwiSaverStatus(input.taxProfile, input.payPeriodEnd);
  return calculateKiwiSaver({ ...input, resolution });
}
