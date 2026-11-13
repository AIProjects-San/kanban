// NZ statutory engine — Phase 3 (super-admin admin UI) client types.
// (Split from the former lib/types/index.ts god-file.)


// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3 (super-admin admin UI) client types.
// ---------------------------------------------------------------------------

/** One editable slab row in the tax-year table (Task 3.1). group names
 * the rate family; code is the secondary code (or the family label);
 * lower/upper are annual dollar bounds (null upper = open-ended). */
export interface TaxSlabRowT {
  id: string;
  group: "PAYE" | "SECONDARY" | "ESCT";
  code: string;
  label: string;
  lower: number | null;
  upper: number | null;
  /** Percent, e.g. 17.5 (not 0.175). */
  rate: number;
  /** True = the rate already includes the ACC levy (combined rate). */
  accInclusive: boolean;
  order: number;
}

/** The single-value rule families rendered under the slab table. */
export interface TaxRuleParamsT {
  acc: { rate: number; maxEarnings: number; maxLevy: number } | null;
  ietc:
    | { annualAmount: number; lowerBound: number; abateFrom: number; upperBound: number; abateRate: number }
    | null;
  kiwiSaver: { defaultEmployeeRate: number; allowedEmployeeRates: number[]; employerRate: number } | null;
  studentLoan: { rate: number; annualThreshold: number } | null;
}

/** One tax year (a StatutoryRateSet) as the admin editor sees it. */
export interface TaxYearAdminT {
  id: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
  notes: string;
  slabs: TaxSlabRowT[];
  params: TaxRuleParamsT;
  /** LOCKED runs that reference this set (delete blocked, edit → new
   * version) — the Task 3.2 archive-only guard. */
  lockedRunCount: number;
  createdAt: string;
}

/** simulateTaxYear result (Task 3.1's Simulate button). */
export interface TaxSimulateResultT {
  tax: number;
  acc: number;
  total: number;
  method: string;
  ietc: number;
  annualised: number;
  rateSetLabel: string;
  ruleVersion: string;
}

/** Task 3.4 — the employee tax profile as the admin editor sees it.
 * Dates are YYYY-MM-DD strings ("" = empty); rates are PERCENT numbers
 * (3.5 = 3.5%); the tax code is stored base + studentLoan flag and
 * composed into the " SL"-suffixed DB convention on save. */
export interface EmployeeTaxProfileT {
  userId: string;
  userName: string;
  userEmail: string;
  exists: boolean;
  irdNumber: string;
  taxCodeBase: string;
  studentLoan: boolean;
  taxCodeEffectiveFrom: string;
  stcCertificateRate: number | null;
  stcAccTreatment: "INC" | "PLUS";
  stcStudentLoanRate: number | null;
  stcCertificateExpiry: string;
  kiwiSaverStatus:
    | "ACTIVE"
    | "NOT_ENROLLED"
    | "OPTED_OUT"
    | "ON_HOLIDAY"
    | "NOT_ELIGIBLE";
  kiwiSaverEmployeeRate: number | null;
  kiwiSaverEmployerRate: number | null;
  esctRateOverride: number | null;
  employmentType: "PERMANENT" | "CASUAL" | "TEMPORARY" | "CASUAL_AGRICULTURAL";
  casualHolidayPayInWages: boolean;
  employmentStartDate: string;
  employmentEndDate: string;
  notes: string;
  /** The rate set's allowed employee rates (percent numbers, for the
   * dropdown) + the default. */
  allowedEmployeeRates: number[];
  defaultEmployeeRate: number;
  employerRate: number;
}

/** Auto-enrolment preview shown live on the profile editor (Task 3.4). */
export interface TaxProfilePreviewT {
  resolvedStatus: string;
  reason: string;
  autoEnrolTriggered: boolean;
  dueDate: string | null;
}
