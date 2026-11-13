// Payroll types — salary structures/components/assignments/advances, payroll
// runs + payslips (LOP details, per-component YTD, the statutory snapshot),
// pay adjustments, benefits, LWP corrections, arrears, gratuity, and
// withholding. Client-safe mirrors of the Prisma models.
// (Split from the former lib/types/index.ts god-file.)

import type { PayrollFrequency } from "@/lib/payroll/payroll-windows";
import type { OfferComponentT } from "./hiring";

/** P10 — the payroll cadence union (lib/payroll/payroll-windows.ts owns it). */
export type PayrollFrequencyT = PayrollFrequency;

/** P39 (EM-16 advances half) — one salary advance + its live state. */
export interface SalaryAdvanceT {
  id: string;
  userId: string;
  userName: string;
  amount: number;
  status: "OPEN" | "RECOVERED";
  installments: number;
  startPeriod: string;
  reason: string;
  issuedBy: string | null;
  issuedAt: string;
  recoveredAt: string | null;
  /** The consumed installments' count/total (the adapter rows' state). */
  consumedCount: number;
  consumedTotal: number;
  outstanding: number;
  summary: string;
}

/** R7 — one monthly money line on a payslip (see lib/payroll/payroll-math.ts). */
export interface PayslipLineT {
  key: string;
  label: string;
  amount: number;
  /** PR-B03 (S8) — display-only line (sparse): never counted into totals. */
  statistical?: boolean;
}

/** Phase 1B (G8) — one effective-dated salary assignment on the employee's
 *  timeline: the [fromDate, toDate) window (toDate null = current), the
 *  structure that priced it, and the annual base / variable salary facts. */
export interface SalaryAssignmentT {
  id: string;
  employeeId: string;
  structureId: string;
  fromDate: string;
  toDate: string | null;
  base: number;
  variable: number;
  reason: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string;
  /** True when the referenced structure is the employee's current active row. */
  structureActive: boolean;
}

/** R7 — an employee's standing salary structure (annual components; the
 * payslip generator divides by 12). */
export interface SalaryStructureT {
  id: string;
  userId: string;
  userName: string;
  jobTitle: string;
  department: string;
  /** Copied from the signed offer when created from one (display hint). */
  source: "OFFER" | "MANUAL";
  components: OfferComponentT[];
  notes: string;
  effectiveFrom: string;
  isActive: boolean;
  createdAt: string;
  /** P5 (PR-15/PR-B04, F3.2) — the flexible-benefit cap (annual; 0 = no
   * cap). Pre-P5 rows read as 0. */
  maxBenefits: number;
  /** P10 (PR-B05) — the cadence this structure pays on (PR-03's
   * payroll_frequency). Pre-P10 rows read as MONTHLY. */
  frequency: PayrollFrequencyT;
  /** P16 (PR-04) — optional component-keyed YTD opening rows (annual
   * amounts earned before this system; seeds the fiscal year containing
   * this structure's effectiveFrom in the read-time aggregates). null =
   * none (pre-P16 rows). */
  openingYtd: OpeningYtdRowT[] | null;
  /** P23 (PR-03) — the workspace default package flag: at most one
   * structure carries it; new structures prefill from its components.
   * Pre-P23 rows read false. */
  isDefault: boolean;
}

/** P16 (PR-04) — one opening row on a structure. gross/net openings derive
 * from the rows at aggregate time (Σ earnings − Σ deductions). */
export interface OpeningYtdRowT {
  key: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  amount: number;
}

/** F1.5 — one catalog row of the salary component vocabulary
 * (payroll:manage). `code` joins onto OfferComponentT.key; the structure
 * editor's picker prefills a line from a row. defaultAmount is a SUGGESTION
 * by mode (FIXED → annual amount; PERCENT_OF_* → percent of the named
 * basis — P23 widens the percent vocabulary) — structures snapshot their
 * own copies, so this never rewrites history. */
export interface SalaryComponentT {
  id: string;
  code: string;
  label: string;
  kind: "EARNING" | "EMPLOYER_CONTRIBUTION" | "DEDUCTION" | "STATISTICAL";
  mode: "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  defaultAmount: number;
  /** PR-B02 (S6) — depends_on_payment_days: false = window-exempt flat
   * line (no S5 scaling, no LOP docking). Default true. */
  dependsOnPaymentDays: boolean;
  /** P16 (PR-11) — optional catalog validity window (null = unbounded).
   * The structure editor badges rows whose window doesn't cover the
   * structure's effectiveFrom; saveSalaryStructure refuses them. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Phase 3 (Task 3.3) — statutory tax mapping. taxApplicable: money
   * from this component counts as taxable income. statutoryCategory: how
   * the engine classifies the line. wageBaseRef: the statutory wage base
   * it feeds (GROSS | NONE). isSystemGenerated: read-only in the mapping
   * editor — the seed / engine owns the row. */
  taxApplicable: boolean;
  statutoryCategory:
    | "TAXABLE_EARNING"
    | "NON_TAXABLE"
    | "PRE_TAX_DEDUCTION"
    | "POST_TAX_DEDUCTION"
    | "EMPLOYER_CONTRIBUTION"
    | "STATISTICAL";
  wageBaseRef: "GROSS" | "NONE";
  isSystemGenerated: boolean;
  createdAt: string;
}

/** Phase 2 (engine wiring) — the frozen statutory computation snapshot on a
 * payslip (Payslip.statutory). Everything the NZ engine derived for this
 * slip's period: the resolved tax code, the rate set that priced it, the
 * per-line amounts, and the inputs they came from. Employee-side lines also
 * ride the deductions JSON (keys paye/acc/ks/sl); employer-side money
 * (employer KiwiSaver, ESCT) lives ONLY here. null = pre-engine slip. */
export interface PayslipStatutoryT {
  /** The declared IR330 code as applied (SL suffix included). */
  taxCode: string;
  rateSetId: string;
  rateSetLabel: string;
  /** Content hash of every rate consumed (see nzRuleVersion). */
  ruleVersion: string;
  frequency: string;
  /** ISO date the enrolment rules were evaluated at (the window end). */
  payPeriodEnd: string;
  /** The gross the engine saw: taxable earnings after the LOP dock and the
   *  Task 3.3 component-mapping exclusions / pre-tax deductions. */
  taxableGross: number;
  /** True = no EmployeeTaxProfile row existed — the system defaults (M /
   *  ACTIVE / PERMANENT) were applied. Honest display + audit signal. */
  defaultedProfile: boolean;
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
  kiwiSaver: {
    status: string;
    reason: string;
    autoEnrolTriggered: boolean;
    employee: number;
    employerGross: number;
    esct: number;
    employerNet: number;
    employeeRate: number;
    employerRate: number;
    esctRate: number;
  };
  studentLoan: number;
  /** taxableGross − PAYE total − employee KiwiSaver − student loan (the
   *  engine's statutory net; the slip's net additionally carries LOP,
   *  structure deductions, adjustments and rounding). */
  statutoryNet: number;
}

/** R7 — one monthly payroll period. status: OPEN (editable) → LOCKED (paid,
 * immutable). Totals are aggregated across the run's payslips. workingDays
 * (F1.1) is the holiday-aware LOP denominator denormalized at creation
 * (0 = pre-F1.1 run → readers fall back to the calendar month length). */
export interface PayrollRunT {
  id: string;
  period: string;
  /** P10 — the cadence key + the run's real window (ISO dates; null only
   * for rows that predate the P10 backfill, where the client falls back to
   * parsing `period`). */
  frequency: "MONTHLY" | "BIMONTHLY" | "WEEKLY" | "FORTNIGHTLY" | "DAILY" | "QUARTERLY" | "ANNUAL";
  startDate: string | null;
  endDate: string | null;
  /** Phase 2 (payday filing) — the PAYDAY: the day the payment is made.
  * The EI filing deadline (payDate + 2 working days) runs from here.
  * Null only for pre-Phase-2 rows (clients fall back to endDate). */
  payDate: string | null;
  status: "OPEN" | "LOCKED";
  lockedBy: string | null;
  lockedAt: string | null;
  payslipCount: number;
  totalGross: number;
  totalNet: number;
  workingDays: number;
  createdAt: string;
}

/** R7 — one employee's payslip in a run. Lines are monthly amounts;
 * ytdNet accumulates the same-year periods up to and including this one.
 * runWorkingDays (F1.1) mirrors the run's holiday-aware denominator so the
 * editor's live LOP preview matches the server's stored math.
 * lopSource (F1.4): AUTO = lopDays was derived at run creation from
 * attendance + unpaid leave; MANUAL = an HR override (audited). */
export interface PayslipT {
  id: string;
  runId: string;
  runPeriod: string;
  runStatus: "OPEN" | "LOCKED";
  runWorkingDays: number;
  userId: string;
  userName: string;
  jobTitle: string;
  slipNo: string;
  earnings: PayslipLineT[];
  deductions: PayslipLineT[];
  note: string;
  lopDays: number;
  lopSource: "AUTO" | "MANUAL";
  /** P15 (PR-06) — the creation-time charge breakdown (the Salary Slip
   * Leave child, Fernly-shaped). null = nothing was docked, the slip
   * predates P15, or a MANUAL LOP override replaced the derivation. */
  lopDetail: LopDetailT | null;
  /** F-R2 (S1) — optimistic-lock version; carried back as expectedVersion
   * when the modal saves, refused on mismatch. */
  version: number;
  /** PR-B06 (S5) — working days inside the employment window, snapshotted at
   * creation; earnings are scaled to it. null = pre-S5 full-period rows. */
  paidDays: number | null;
  gross: number;
  net: number;
  ytdNet: number;
  /** P11 (PR-B09) — read-time period aggregates: YTD gross alongside the
   * YTD net, month-to-date net (the calendar month of the run's window
   * end — meaningful when several slips land in one month, e.g. weekly
   * cadences), and per-component YTD rows for the modal's per-line
   * display. WITHHELD/RELEASED slips carry the last paid values. */
  ytdGross: number;
  mtdNet: number;
  componentYtd: ComponentYtdRowT[];
  /** P16 (PR-11) — the fiscal-year basis the aggregates were computed under
   * (1 = calendar year; the modal renders "YTD (FY 2026/27)" otherwise).
   * Optional: omitted by older callers / the live preview. */
  fiscalYearStartMonth?: number;
  /** P17 (PR-B25) — the employee's live leave balances at read time (the
   * benchmark's show_leave_balances_in_salary_slip): one row per type with
   * available days. Present only when the workspace toggle is on; never
   * snapshotted onto the slip. */
  leaveBalances?: { typeName: string; availableDays: number }[];
  /** P8 (PR-19/PR-B13) — "" normal | WITHHELD (net held, not disbursed;
   * excluded from YTD) | RELEASED (paid via a WITHHELD_RELEASE adjustment
   * in a later period). */
  withholdStatus: "" | "WITHHELD" | "RELEASED";
  /** Phase 2 (engine wiring) — the frozen statutory computation snapshot
   *  (PAYE/ACC/KiwiSaver/student loan lines + employer-side money). Absent
   *  or null = pre-engine slip or the run had no covering rate set. */
  statutory?: PayslipStatutoryT | null;
}

/** P15 (PR-06) — one leave row of the payslip's frozen LOP breakdown:
 * the working days the span covered inside the run's window (takenDays),
 * the days it docked (chargedDays = Σ (1 − fraction) × working fraction),
 * the type's salary fraction paid per day (1 = fully paid; 0 for unpaid
 * types), and the paid flag for display. */
export interface LopDetailLeaveRowT {
  leaveTypeId: string;
  code: string;
  name: string;
  takenDays: number;
  chargedDays: number;
  fraction: number;
  paid: boolean;
}

/** P15 (PR-06) — the per-slip LOP charge breakdown frozen at creation
 * (Payslip.lopDetail): which leave spans covered the window plus the
 * attendance-side docks. Every number is a working-day fraction. */
export interface LopDetailT {
  absentDays: number;
  halfDays: number;
  unmarkedDays: number;
  leave: LopDetailLeaveRowT[];
}

/** P11 (PR-B09) — one per-component YTD row (side + line key + running
 * year total). */
export interface ComponentYtdRowT {
  key: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  amount: number;
}

/** P1 (PR-12/PR-B10, F2.3) — one adapter row: a special payment (encashment,
 * arrears delta, LWP credit, retention bonus, benefit payout, withheld
 * release, manual incentive) waiting for the run covering its period to
 * resolve it into payslip lines. userName resolved per row for the list. */
export interface PayAdjustmentT {
  id: string;
  userId: string;
  userName: string;
  sourceType: string;
  sourceId: string;
  componentCode: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  recurrence: "ONE_SHOT" | "RECURRING" | "OVERWRITE";
  calcMode: "FIXED" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  percent: number | null;
  amount: number;
  period: string;
  endPeriod: string | null;
  lastConsumedPeriod: string;
  status: "PENDING" | "CONSUMED" | "SKIPPED";
  skipReason: string;
  note: string;
  consumedRunPeriod: string;
  createdAt: string;
}

/** P5 (PR-15–18, PR-B04, F3.2) — the Benefits panel's data: this year's
 * elections with live accrued balances (Σ ledger deltas) and the structure
 * cap per employee. */
export interface BenefitsOverviewT {
  year: number;
  rows: Array<{
    id: string;
    userId: string;
    userName: string;
    year: number;
    componentCode: string;
    label: string;
    annualAmount: number;
    status: "ACTIVE" | "CANCELLED";
    cap: number;
    balance: number;
    createdAt: string;
  }>;
}

/** P4 (PR-14/PR-B12, F3.1) — one paid slip's LWP-reversal facts for the
 * correction modal: what was docked (days + the stored LOP line's amount),
 * what was already reversed (Σ sourceDays of LWP_CREDIT rows), and the
 * per-day price the refund uses. */
export interface LwpCorrectionPreviewT {
  payslipId: string;
  userId: string;
  userName: string;
  slipNo: string;
  period: string;
  storedLopDays: number;
  storedLopAmount: number;
  alreadyReversedDays: number;
  reversibleDays: number;
  perDay: number;
}

/** P3 (PR-13/PR-B11, F3.1) — one LOCKED slip's arrears verdict from the
 * preview: what it paid, what it would pay under the current structure,
 * the positive delta owed (arrears), and whether an ARREARS row already
 * covers it (idempotency). */
export interface ArrearsPreviewT {
  payslipId: string;
  userId: string;
  userName: string;
  slipNo: string;
  period: string;
  storedNet: number;
  simulatedNet: number;
  delta: number;
  owed: boolean;
  reason: string;
  alreadyArranged: boolean;
}

// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — the gratuity rule (config) and its slabs.
// ---------------------------------------------------------------------------

/** One years→fraction band of the gratuity rule. */
export interface GratuitySlabT {
  id: string;
  fromYears: number;
  toYears: number | null;
  fraction: number;
}

/** The workspace's gratuity rule (singleton row + slab rows). */
export interface GratuityRuleT {
  enabled: boolean;
  averagingMonths: number;
  slabs: GratuitySlabT[];
}

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary withholding (the lite state machine).
// ---------------------------------------------------------------------------

/** One hold window + its terminal release (listSalaryWithholdings rows). */
export interface SalaryWithholdingT {
  id: string;
  userId: string;
  userName: string;
  fromPeriod: string;
  untilPeriod: string | null;
  reason: string;
  status: "ACTIVE" | "RELEASED";
  /** Where the held net was/will be paid (RELEASED rows). */
  releasePeriod: string | null;
  releasedAt: string | null;
  /** Live hold balance: WITHHELD slips not yet released. */
  heldSlipCount: number;
  heldTotal: number;
}
