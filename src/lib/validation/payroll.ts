// ---------------------------------------------------------------------------
// Payroll schemas — salary structures + the component catalog + advances,
// payroll runs/payslips, the manual PayAdjustment writer, arrears, LWP
// corrections, flexible benefits, retention bonuses, gratuity, withholding,
// and the per-run CSV exports.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { parsePayrollPeriodKey, PAYROLL_FREQUENCY_VALUES } from "@/lib/payroll/payroll-windows";
import { cuidish } from "./common";
import {
  OFFER_COMPONENT_KINDS,
  OFFER_COMPONENT_MODES,
  offerComponentSchema,
  refineOfferComponent,
} from "./hiring";


// -------------------------------------------------------------------------
// P39 (EM-16's advances half) — salary advances: issue + the recovery
// through the PayAdjustment adapter.
// -------------------------------------------------------------------------

export const issueSalaryAdvanceSchema = z.object({
  userId: cuidish,
  amount: z.number().min(0.01, "The advance amount must be positive.").max(1_000_000),
  installments: z.number().int().min(1, "At least one installment.").max(24, "At most 24 installments."),
  startPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "The start period must be YYYY-MM."),
  reason: z.string().trim().max(2_000).default(""),
}).strict();

// ---------------------------------------------------------------------------
// R7 — payroll (docs/RECRUITMENT_MODULE_PLAN.md §5). Salary structures reuse
// the offer component schema (annual amounts); payslip lines are monthly
// { key, label, amount } rows; periods are "YYYY-MM".
// ---------------------------------------------------------------------------

export const PAYROLL_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** P10 (PR-B05) — any cadence's period key (2026-11, 2026-11-A, 2026-W45,
 * 2026-F23, 2026-11-09, 2026-Q4, 2026) — the adjustment adapter's target
 * periods accept all of them (lib/payroll/payroll-windows.ts is the single
 * authority on what parses). */
export const payrollPeriodKey = z
  .string()
  .trim()
  .refine((k) => parsePayrollPeriodKey(k) != null, "Pick a payroll period key (2026-11, 2026-W45, …).");

export const payslipLineSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  amount: z.number().min(0).max(10_000_000),
  // PR-B02 (S6) — the payment-days exemption snapshot on the line (sparse:
  // only false is meaningful; absent = true). Submitted lines carry it so
  // updatePayslip can recompute the LOP on the day-scaled basis only.
  dependsOnPaymentDays: z.boolean().optional(),
  // PR-B03 (S8) — display-only line flag (sparse).
  statistical: z.boolean().optional(),
}).strict();

export const saveSalaryStructureSchema = z.object({
  id: cuidish.optional(),
  userId: cuidish,
  components: z.array(offerComponentSchema).max(30),
  notes: z.string().trim().max(2_000).default(""),
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.").optional(),
  isActive: z.boolean().default(true),
  // P5 (PR-15/PR-B04, F3.2) — the flexible-benefit cap (annual; 0 = no cap).
  // Optional in the wire shape: omitted = keep the stored value.
  maxBenefits: z.number().min(0).max(10_000_000).optional(),
  // P10 (PR-B05, PR-03 payroll_frequency) — the cadence this structure pays
  // on (default MONTHLY keeps every pre-P10 call byte-identical; only
  // structures matching a run's cadence join it).
  frequency: z.enum(PAYROLL_FREQUENCY_VALUES).default("MONTHLY"),
  // P16 (PR-04 opening balances) — optional component-keyed YTD opening rows
  // (annual amounts earned before this system; seeds the fiscal year that
  // contains this structure's effectiveFrom). Absent = keep the stored
  // value (the P5 maxBenefits wire convention); null = clear.
  openingYtd: z
    .array(
      z
        .object({
          key: z.string().trim().min(1, "A component code is required.").max(60),
          label: z.string().trim().max(120).default(""),
          side: z.enum(["EARNING", "DEDUCTION"]),
          amount: z.number().min(0).max(100_000_000),
        })
        .strict(),
    )
    .max(30)
    .nullable()
    .optional(),
  // P23 (PR-03) — the workspace default package flag: at most ONE
  // structure carries it (saving one clears the previous — atomic); its
  // duty is the PREFILL of new structures (the hard-coded basic-only
  // prefill becomes data). Absent = keep the stored value (the
  // maxBenefits wire convention).
  isDefault: z.boolean().optional(),
}).strict();

// F1.5 — the salary component catalog (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). `code` follows the OfferComponent.key convention (lowercase snake)
// so catalog rows and structure lines join on it. defaultAmount is a
// suggestion by mode: FIXED → annual amount; PERCENT_OF_* → percent of the
// named basis (same dual meaning as OfferComponent.amount; P23 widens the
// percent vocabulary).
export const saveSalaryComponentSchema = z.object({
  id: cuidish.optional(),
  code: z.string().trim().min(1, "A code is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  kind: z.enum(OFFER_COMPONENT_KINDS),
  mode: z.enum(OFFER_COMPONENT_MODES),
  defaultAmount: z.number().min(0).max(100_000_000),
  // PR-B02 (S6) — depends_on_payment_days: default true (the pre-S6
  // implicit behavior — every line scaled with the employment window and
  // was docked by LOP). false = window-exempt flat line.
  dependsOnPaymentDays: z.boolean().default(true),
  // P16 (PR-11 component effective windows) — optional catalog validity
  // window (YYYY-MM-DD; null/absent = unbounded). from must precede to.
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.").nullable().optional(),
  effectiveTo: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.").nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
}).strict()
  .refine(
    (d) =>
      !d.effectiveFrom || !d.effectiveTo || d.effectiveFrom <= d.effectiveTo,
    { message: "The effective window's start must precede its end." },
  )
  // P23 — the catalog rows obey the same component-line rules as the
  // lines they prefill (percent-of-net is deduction-only; the new percent
  // modes carry a percent in (0, 100]).
  .superRefine((d, ctx) =>
    refineOfferComponent({ kind: d.kind, mode: d.mode, amount: d.defaultAmount }, ctx),
  );

export const deleteSalaryComponentSchema = z.object({
  id: cuidish,
}).strict();

export const createPayrollRunSchema = z.object({
  // P10 (PR-B05) — the cadence + an anchor date inside the target window;
  // the server resolves both through the payroll-windows kernel (the ONE
  // authority — the modal's preview imports the same pure functions).
  frequency: z.enum(PAYROLL_FREQUENCY_VALUES),
  anchorDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an anchor date (YYYY-MM-DD) inside the window."),
  // Phase 2 (payday filing) — the PAYDAY (the day the payment is made;
  // the 2-working-day IRD filing deadline runs from it). Optional here
  // for Phase 1 contract stability: omitted = the window's end date.
  // The UI always sends it explicitly (defaulted, editable).
  payDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a pay date (YYYY-MM-DD).").optional(),
  // P14 (PR-04, the payroll-entry employee filter lite) — restrict the run
  // to the selected employees' structures (still frequency-matched);
  // omitted/empty = every active structure of the cadence (the default).
  userIds: z.array(cuidish).max(200).optional(),
}).strict();

// P14 (PR-33, the bulk salary structure assignment) — one component set
// assigned to many employees at once (each employee's ACTIVE structure is
// replaced transactionally — retire + create, the F-R1 discipline).
export const bulkAssignStructureSchema = z.object({
  userIds: z.array(cuidish).min(1, "Pick at least one employee.").max(200, "Bulk assignment is capped at 200 employees per batch."),
  components: z.array(offerComponentSchema).min(1, "A structure needs at least one component.").max(30),
  notes: z.string().trim().max(2_000).default(""),
  frequency: z.enum(PAYROLL_FREQUENCY_VALUES).default("MONTHLY"),
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.").optional(),
}).strict();

export const updatePayslipSchema = z.object({
  payslipId: cuidish,
  // F-R2 (S1) — optimistic lock: the Payslip.version this editor loaded.
  // A mismatch (another editor saved first) refuses the save; the modal
  // re-reads on reopen. Required, not defaulted — a missing version must
  // never silently degrade to last-write-wins.
  expectedVersion: z.number().int().min(0),
  earnings: z.array(payslipLineSchema).max(40),
  deductions: z.array(payslipLineSchema).max(40),
  // F1.4: fractional days are legal — HALF_DAY attendance derives 0.5 (and
  // HALF_DAY on a half-day holiday 0.25); the server rounds to 2 decimals.
  lopDays: z.number().min(0).max(31).default(0),
  note: z.string().trim().max(500).default(""),
}).strict();

export const lockPayrollRunSchema = z.object({
  runId: cuidish,
}).strict();

// P20 (PR-R01/PR-R02) — the per-run CSV exports. LOCKED runs only (paid
// money only); the kind picks the register vs the bank remittance shape.
export const exportPayrollCsvSchema = z.object({
  runId: cuidish,
  kind: z.enum(["REGISTER", "BANK_REMITTANCE"]),
}).strict();

export const addPayslipSchema = z.object({
  runId: cuidish,
  userId: cuidish,
}).strict();

// P1 (PR-12/PR-B10, F2.3) — the manual adjustment writer. Shape-only
// validation here (periods, enums, non-negative amount); the semantic
// matrix (percent-vs-side, endPeriod order) lives in the pure kernel's
// validateAdjustmentInput so both the action and the UI share one rule.
export const createPayAdjustmentSchema = z.object({
  userId: cuidish,
  // MANUAL/INCENTIVE are the hand-made sources; the feature-owned sources
  // (ENCASHMENT, ARREARS, …) are written by their own actions, never
  // through this schema.
  sourceType: z.enum(["MANUAL", "INCENTIVE"]).default("MANUAL"),
  componentCode: z.string().trim().max(40).default(""),
  label: z.string().trim().max(80).default(""),
  side: z.enum(["EARNING", "DEDUCTION"]),
  recurrence: z.enum(["ONE_SHOT", "RECURRING", "OVERWRITE"]).default("ONE_SHOT"),
  calcMode: z.enum(["FIXED", "PERCENT_OF_GROSS", "PERCENT_OF_NET"]).default("FIXED"),
  percent: z.number().min(0).max(100).nullish(),
  amount: z.number().min(0).max(10_000_000).default(0),
  period: payrollPeriodKey,
  endPeriod: payrollPeriodKey.nullish(),
  note: z.string().trim().max(500).default(""),
}).strict();

// P3 (PR-13/PR-B11, F3.1) — arrears preview + generation.
export const arrearsPreviewSchema = z.object({
  runId: cuidish,
}).strict();

export const generateArrearsSchema = z.object({
  runId: cuidish,
  payoutPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick a payout month (YYYY-MM)."),
}).strict();

// P4 (PR-14/PR-B12, F3.1) — LWP correction preview + reversal.
export const previewLwpCorrectionSchema = z.object({
  payslipId: cuidish,
}).strict();

export const reverseLwpDaysSchema = z.object({
  payslipId: cuidish,
  days: z.number()
    .refine((n) => n > 0, "Reversal needs a positive number of days.")
    .refine((n) => n <= 31, "Reversals are capped at 31 days.")
    .refine((n) => Math.round(n * 4) === n * 4, "Reversals move in quarter-day steps."),
  payoutPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick a payout month (YYYY-MM)."),
  note: z.string().trim().max(500).default(""),
}).strict();

// P5 (PR-15–18, PR-B04, F3.2) — flexible benefits: election, claim, cancel.
export const electBenefitSchema = z.object({
  userId: cuidish,
  year: z.number().int().min(2020).max(2100),
  componentCode: z.string().trim().min(1, "A component code is required.").max(40),
  label: z.string().trim().max(80).default(""),
  annualAmount: z.number().min(0.01, "The elected annual amount must be positive.").max(1_000_000),
}).strict();

export const cancelBenefitElectionSchema = z.object({
  electionId: cuidish,
}).strict();

export const claimBenefitSchema = z.object({
  userId: cuidish,
  year: z.number().int().min(2020).max(2100),
  componentCode: z.string().trim().min(1).max(40),
  amount: z.number().min(0.01, "The claim amount must be positive.").max(1_000_000),
  payoutPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick a payout month (YYYY-MM)."),
  note: z.string().trim().max(500).default(""),
}).strict();

// P6 (PR-20/PR-23, PR-T01) — the retention-bonus writer.
export const createRetentionBonusSchema = z.object({
  userId: cuidish,
  totalAmount: z.number().min(0.01, "The bonus total must be positive.").max(10_000_000),
  installments: z.number().int().min(1).max(12),
  firstPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick a first payout month (YYYY-MM)."),
  note: z.string().trim().max(500).default(""),
}).strict();

// P7 (PR-20/PR-21, F3.3) — the gratuity rule editor. Shape-level checks
// only; overlap/coverage logic lives in the pure kernel
// (validateGratuityRuleInput) so the rule math stays tested in one place.
const gratuitySlabSchema = z.object({
  fromYears: z.number().int().min(0).max(80),
  toYears: z.number().int().min(1).max(120).nullable(),
  fraction: z.number().min(0).max(12),
}).strict();

export const saveGratuityRuleSchema = z.object({
  enabled: z.boolean(),
  averagingMonths: z.number().int().min(1).max(12),
  slabs: z.array(gratuitySlabSchema).max(40),
}).strict();

// P8 (PR-19/PR-B13, F3.3) — salary withholding: hold window + release.
export const createSalaryWithholdingSchema = z.object({
  userId: cuidish,
  fromPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick the first held month (YYYY-MM)."),
  untilPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick the last held month (YYYY-MM).").nullable(),
  reason: z.string().trim().max(500).default(""),
}).strict();

export const releaseWithholdingSchema = z.object({
  withholdingId: cuidish,
  releasePeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick the release payout month (YYYY-MM)."),
  note: z.string().trim().max(500).default(""),
}).strict();
