// ---------------------------------------------------------------------------
// NZ statutory payroll engine — Task 1.2 (revised): KiwiSaver calculator
// with casual/temporary auto-enrolment logic.
//
// Two pure functions, per the user's design:
//
//   resolveKiwiSaverStatus(profile, payPeriodEnd) — the STATUS TRANSITION
//   check, never a calculation. Maps the DB election vocabulary (Phase 0:
//   ACTIVE / OPTED_OUT / ON_HOLIDAY / NOT_ELIGIBLE; Phase 3 adds
//   NOT_ENROLLED — recorded by the admin as "not in the scheme") onto the
//   engine's effective statuses and applies IRD's auto-enrolment exemptions
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
//       worked — day 1 is the employment start date, so day 29 falls
//       exactly 28 days after it (a 1 March start auto-enrols on
//       29 March).
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

// ---------------------------------------------------------------------------
// Phase 1A time-rule constants (IRD "Opting in and enrolling temporary and
// casual employees") — the seed file and the admin UI import these so the
// rules live in exactly one place.
// ---------------------------------------------------------------------------

/** Temporary employment: auto-enrol from day 29 (start + 28 days). */
export const TEMP_MAX_DAYS = 28;

/** Casual agricultural: exempt for fewer than 3 months, enrolled beyond. */
export const CASUAL_AGRI_MAX_MONTHS = 3;

/**
 * Phase 1A legacy profile shape (verify-phase-1a.sh): employmentType (the
 * DB column name) instead of the engine's employmentCategory, percent-unit
 * employee/employer rates that are NOT election evidence, and
 * kiwiSaverStatus "NOT_ENROLLED" meaning PRE-enrolment (no election yet —
 * still eligible for the time rules) rather than the admin-recorded
 * "not in the scheme" reading the DB column carries.
 */
export interface NzLegacyTaxProfile {
  taxCode: string;
  studentLoan?: boolean;
  kiwiSaverStatus: string;
  kiwiSaverEmployeeRate?: number | null;
  kiwiSaverEmployerRate?: number | null;
  esctRateOverride?: number | null;
  taxCodeSpecialRate?: number | null;
  stcAccTreatment?: "INC" | "PLUS" | null;
  stcStudentLoanRate?: number | null;
  employmentType: string;
  casualHolidayPayInWages?: boolean;
  employmentStartDate?: Date | null;
  employmentEndDate?: Date | null;
}

/** Canonical profiles carry employmentCategory — the engine's own shape. */
function isCanonicalProfile(
  p: NzTaxProfileInput | NzLegacyTaxProfile,
): p is NzTaxProfileInput {
  return "employmentCategory" in p;
}

/** Normalize either profile shape into the engine's decision input. */
function toDecisionInput(profile: NzTaxProfileInput | NzLegacyTaxProfile): NzTaxProfileInput {
  if (isCanonicalProfile(profile)) return profile;
  const legacy = profile as NzLegacyTaxProfile;
  const category = ["PERMANENT", "CASUAL", "TEMPORARY", "CASUAL_AGRICULTURAL"].includes(
    legacy.employmentType,
  )
    ? (legacy.employmentType as NzTaxProfileInput["employmentCategory"])
    : "PERMANENT";
  return {
    taxCode: legacy.taxCode,
    isCasual: category === "CASUAL" || category === "CASUAL_AGRICULTURAL",
    employmentCategory: category,
    employmentStartDate: legacy.employmentStartDate ?? null,
    casualHolidayPayInWages: legacy.casualHolidayPayInWages ?? false,
    // Legacy NOT_ENROLLED = the pre-enrolment posture (the ACTIVE election
    // vocabulary); the time rules stay live. Unknown strings fall through
    // the decision switch to the ACTIVE posture — same as the row adapter.
    kiwiSaverStatus: (legacy.kiwiSaverStatus === "NOT_ENROLLED"
      ? "ACTIVE"
      : legacy.kiwiSaverStatus) as NzTaxProfileInput["kiwiSaverStatus"],
    // Percent-unit rates are scheme parameters here, NOT election evidence.
    kiwiSaverRate: null,
    employerKiwiSaverRate: null,
    esctRateOverride: legacy.esctRateOverride ?? null,
    taxCodeSpecialRate: legacy.taxCodeSpecialRate ?? null,
    stcAccTreatment: legacy.stcAccTreatment ?? "INC",
    stcStudentLoanRate: legacy.stcStudentLoanRate ?? null,
    stcStudentLoanThresholdApplies: true,
  };
}

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

/** Add whole days to a UTC date. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
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
 * The calendar date a pending auto-enrolment trigger fires (the admin
 * profile editor's preview line — Phase 3). Null when the category has no
 * time rule or the start date is missing:
 *   TEMPORARY           day 29 = employment start + TEMP_MAX_DAYS (28)
 *   CASUAL_AGRICULTURAL the day after CASUAL_AGRI_MAX_MONTHS (3) whole
 *                       calendar months
 */
export function autoEnrolDueDate(
  category: NzTaxProfileInput["employmentCategory"],
  employmentStartDate: Date | null,
): Date | null {
  if (!employmentStartDate) return null;
  switch (category) {
    case "TEMPORARY":
      return addDays(employmentStartDate, TEMP_MAX_DAYS);
    case "CASUAL_AGRICULTURAL":
      return addDays(addMonthsClamped(employmentStartDate, CASUAL_AGRI_MAX_MONTHS), 1);
    default:
      return null;
  }
}

/**
 * Phase 1A — resolve the effective KiwiSaver STATUS as a bare string
 * ("ENROLLED" | "NOT_ENROLLED" | …). Accepts BOTH the engine's canonical
 * NzTaxProfileInput AND the Phase 1A legacy profile shape
 * (employmentType + percent-unit kiwiSaverEmployeeRate, where
 * kiwiSaverStatus "NOT_ENROLLED" means PRE-enrolment — no election yet,
 * still eligible for the time rules — not the admin-recorded "not in the
 * scheme"). Rich callers (audit reasons, the autoEnrolTriggered flag) use
 * resolveKiwiSaverDecision.
 */
export function resolveKiwiSaverStatus(
  taxProfile: NzTaxProfileInput | NzLegacyTaxProfile,
  payPeriodEnd: Date,
): NzKsStatus {
  return resolveKiwiSaverDecision(toDecisionInput(taxProfile), payPeriodEnd).status;
}

/**
 * Resolve the full KiwiSaver decision for a pay period: the effective
 * status, whether a time rule FIRED this period (the payroll action
 * persists it with an audit entry), and the human-readable reason. Pure;
 * the employment facts arrive on the profile.
 */
export function resolveKiwiSaverDecision(
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

    // Phase 3 — the admin-recorded "not in the scheme" election (the
    // profile editor's NOT_ENROLLED option). Unlike the ACTIVE posture it
    // never auto-enrols at hire: it is an explicit record that this
    // employee is not a member, and neither side contributes.
    case "NOT_ENROLLED":
      return {
        status: "NOT_ENROLLED",
        autoEnrolTriggered: false,
        reason: "Recorded as not enrolled — no employee deduction, no employer contribution",
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

  // Phase 1A — a recorded auto-enrolment EXEMPTION blocks the time rules
  // (an admin-recorded reason this employee must not be auto-enrolled;
  // a voluntary opt-in election above still wins).
  if (taxProfile.autoEnrolExemption) {
    return {
      status: "NOT_ENROLLED",
      autoEnrolTriggered: false,
      reason: `Auto-enrolment exemption on record: ${taxProfile.autoEnrolExemption}`,
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

    // Temporary: auto-enrol from day 29 of continuous employment. Day 1
    // is the start date, so day 29 is start + 28 days — the enrolment
    // fires when a pay period ENDS on or after that date.
    case "TEMPORARY": {
      if (!taxProfile.employmentStartDate) {
        return {
          status: "NOT_ENROLLED",
          autoEnrolTriggered: false,
          reason: "Temporary employment — no start date on record, the 28-day rule cannot trigger",
        };
      }
      const dueDate = autoEnrolDueDate("TEMPORARY", taxProfile.employmentStartDate)!;
      if (payPeriodEnd.getTime() >= dueDate.getTime()) {
        return {
          status: "ENROLLED",
          autoEnrolTriggered: true,
          reason: "Temporary employment passed 28 days in a row — auto-enrolled from day 29",
        };
      }
      const remaining = diffInDays(dueDate, payPeriodEnd);
      return {
        status: "NOT_ENROLLED",
        autoEnrolTriggered: false,
        reason: `Temporary — 28-day rule: auto-enrol on ${dueDate.toISOString().slice(0, 10)} (${remaining} day${remaining === 1 ? "" : "s"} away)`,
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
      const due = autoEnrolDueDate("CASUAL_AGRICULTURAL", taxProfile.employmentStartDate);
      return {
        status: "NOT_ENROLLED",
        autoEnrolTriggered: false,
        reason: `Casual agricultural employment — 3-month rule: auto-enrol on ${due ? due.toISOString().slice(0, 10) : "(no start date)"}`,
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
 *
 * Two input shapes:
 *   canonical — { gross, frequency, taxProfile, resolution, kiwiSaver,
 *                esctTiers } (the payroll run's path) → full result.
 *   Phase 1A legacy flat — { gross, employeeRate, employerRate, esctRate,
 *                status } → the four money lines only.
 */
export interface NzKsFlatInput {
  gross: number;
  employeeRate?: number;
  employerRate?: number;
  esctRate?: number;
  status: NzKsStatus;
}

/** Phase 1A legacy flat result — the four money lines, nothing else. */
export interface NzKsFlatResult {
  employee: number;
  employerGross: number;
  esct: number;
  employerNet: number;
}

export function calculateKiwiSaver(input: CalculateKiwiSaverInput): NzKiwiSaverResult;
export function calculateKiwiSaver(input: NzKsFlatInput): NzKsFlatResult;
export function calculateKiwiSaver(
  input: CalculateKiwiSaverInput | NzKsFlatInput,
): NzKiwiSaverResult | NzKsFlatResult {
  // ---- Phase 1A legacy flat shape: rates + status handed in directly. ----
  if ("status" in input) {
    const flat = input as NzKsFlatInput;
    if (flat.status !== "ENROLLED" && flat.status !== "ON_HOLIDAY") {
      return { employee: 0, employerGross: 0, esct: 0, employerNet: 0 };
    }
    const employeeRate = flat.status === "ON_HOLIDAY" ? 0 : (flat.employeeRate ?? 0);
    const employerRate = flat.employerRate ?? 0;
    const employee = roundMoney2(flat.gross * employeeRate);
    const employerGross = roundMoney2(flat.gross * employerRate);
    const esct = roundMoney2(employerGross * (flat.esctRate ?? 0));
    return {
      employee,
      employerGross,
      esct,
      employerNet: roundMoney2(employerGross - esct),
    };
  }

  const { gross, frequency, taxProfile, resolution, kiwiSaver } = input as CalculateKiwiSaverInput;
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
  const resolution = resolveKiwiSaverDecision(input.taxProfile, input.payPeriodEnd);
  return calculateKiwiSaver({ ...input, resolution });
}
