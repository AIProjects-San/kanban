// ---------------------------------------------------------------------------
// NZ statutory engine schemas — Phase 3 (super-admin admin UI).
//
// Wire convention: every RATE on these schemas is a PERCENT number (17.5 =
// 17.5%); the actions convert to the decimal the engine and DB use. Dollar
// fields are plain annual amounts.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { IR330_BASE_CODES } from "@/lib/payroll/nz/tax-codes";
import { cuidish } from "./common";


// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3 (super-admin admin UI) schemas.
//
// Wire convention: every RATE on these schemas is a PERCENT number (17.5 =
// 17.5%); the actions convert to the decimal the engine and DB use. Dollar
// fields are plain annual amounts.
// ---------------------------------------------------------------------------

const percentRate = z.number().finite().min(0).max(100);
const positiveAmount = z.number().finite().min(0).max(1_000_000_000);
export const yyyymmdd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");

/** Task 3.1 — one editable slab row (PAYE tier / secondary code / ESCT tier). */
export const taxSlabRowSchema = z.object({
  id: cuidish.optional(),
  group: z.enum(["PAYE", "SECONDARY", "ESCT"]),
  code: z.string().trim().min(1).max(12),
  label: z.string().trim().max(120).default(""),
  // Lower bound; null allowed only for SECONDARY (flat rate, no bounds).
  lower: z.number().finite().min(0).max(1_000_000_000).nullable(),
  // Upper bound; null = open-ended top tier.
  upper: z.number().finite().min(0).max(1_000_000_000).nullable(),
  rate: percentRate,
  accInclusive: z.boolean().default(false),
  order: z.number().int().min(0).max(9_999),
}).strict();

const taxAccSchema = z.object({
  rate: percentRate,
  maxEarnings: positiveAmount,
  maxLevy: positiveAmount,
}).strict();

const taxIetcSchema = z.object({
  annualAmount: positiveAmount,
  lowerBound: positiveAmount,
  abateFrom: positiveAmount,
  upperBound: positiveAmount,
  abateRate: percentRate,
}).strict();

const taxKiwiSaverSchema = z.object({
  defaultEmployeeRate: percentRate,
  allowedEmployeeRates: z.array(percentRate).max(12),
  employerRate: percentRate,
}).strict();

const taxStudentLoanSchema = z.object({
  rate: percentRate,
  annualThreshold: positiveAmount,
}).strict();

/** Task 3.1 — save one tax year's full table (slabs + single-value rules). */
export const saveTaxYearSlabsSchema = z.object({
  setId: cuidish,
  slabs: z.array(taxSlabRowSchema).max(60),
  acc: taxAccSchema.nullable(),
  ietc: taxIetcSchema.nullable(),
  kiwiSaver: taxKiwiSaverSchema.nullable(),
  studentLoan: taxStudentLoanSchema.nullable(),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

/** Task 3.1 — the Simulate button (runs the saved set through the engine). */
export const simulateTaxSchema = z.object({
  rateSetId: cuidish,
  code: z.enum(IR330_BASE_CODES),
  gross: z.number().finite().min(0).max(1_000_000_000),
  frequency: z.enum(["WEEKLY", "FORTNIGHTLY", "BIMONTHLY", "MONTHLY", "QUARTERLY", "ANNUAL"]),
  stcCertificateRate: percentRate.nullable().default(null),
  stcAccTreatment: z.enum(["INC", "PLUS"]).default("INC"),
  studentLoan: z.boolean().default(false),
}).strict();

/** Task 3.2 — create a new version of one rule category from a source set. */
export const createRuleVersionSchema = z.object({
  sourceSetId: cuidish,
  category: z.enum(["PAYE", "SECONDARY", "ACC", "IETC", "KIWISAVER", "ESCT", "STUDENT_LOAN"]),
  effectiveFrom: yyyymmdd,
  label: z.string().trim().min(1, "A label is required.").max(140),
  values: z.object({
    slabs: z.array(taxSlabRowSchema).max(60).optional(),
    acc: taxAccSchema.optional(),
    ietc: taxIetcSchema.optional(),
    kiwiSaver: taxKiwiSaverSchema.optional(),
    studentLoan: taxStudentLoanSchema.optional(),
  }).strict(),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

/** Task 3.2 — archive / delete a rate set. */
export const taxYearActionSchema = z.object({ setId: cuidish }).strict();

/** Task 3.3 — one component's tax mapping (inline edit). */
export const componentTaxMappingSchema = z.object({
  id: cuidish,
  taxApplicable: z.boolean(),
  statutoryCategory: z.enum([
    "TAXABLE_EARNING", "NON_TAXABLE", "PRE_TAX_DEDUCTION",
    "POST_TAX_DEDUCTION", "EMPLOYER_CONTRIBUTION", "STATISTICAL",
  ]),
  wageBaseRef: z.enum(["GROSS", "NONE"]),
}).strict();

/** Task 3.4-r1 — the employee tax profile (three-section editor). Rates are
 * percent numbers; dates are YYYY-MM-DD strings ("" = empty, mapped to
 * null). The tax code arrives as base + studentLoan flag and is composed
 * into the DB's " SL"-suffixed convention by the action. */
export const employeeTaxProfileSchema = z.object({
  userId: cuidish,
  irdNumber: z.string().trim().max(20).default(""),
  taxCodeBase: z.enum(IR330_BASE_CODES),
  studentLoan: z.boolean().default(false),
  taxCodeEffectiveFrom: yyyymmdd.nullable().default(null),
  stcCertificateRate: percentRate.nullable().default(null),
  stcAccTreatment: z.enum(["INC", "PLUS"]).default("INC"),
  stcStudentLoanRate: z.number().finite().min(0).max(12).nullable().default(null),
  stcCertificateExpiry: yyyymmdd.nullable().default(null),
  kiwiSaverStatus: z.enum(["ACTIVE", "NOT_ENROLLED", "OPTED_OUT", "ON_HOLIDAY", "NOT_ELIGIBLE"]),
  kiwiSaverEmployeeRate: percentRate.nullable().default(null),
  kiwiSaverEmployerRate: percentRate.nullable().default(null),
  esctRateOverride: percentRate.nullable().default(null),
  employmentType: z.enum(["PERMANENT", "CASUAL", "TEMPORARY", "CASUAL_AGRICULTURAL"]),
  casualHolidayPayInWages: z.boolean().default(true),
  employmentStartDate: yyyymmdd.nullable().default(null),
  employmentEndDate: yyyymmdd.nullable().default(null),
  notes: z.string().trim().max(2_000).default(""),
}).strict();
