// ---------------------------------------------------------------------------
// Leave schemas — requests/decisions, the leave-type master (policy block),
// leave periods, policy sets + assignment, balance adjustments, the balance
// report filters, encashment, and compensatory-leave claims.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, isoDateStr } from "./common";
import { PAYROLL_PERIOD_RE } from "./payroll";


/** P27 (LV-08) — the leave period master payloads. Dates are "YYYY-MM-DD"
 * day keys (the kernel validates the semantics: ordering, span, overlap,
 * chain extension). */
export const leavePeriodCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date must be YYYY-MM-DD."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "End date must be YYYY-MM-DD."),
}).strict(); // reject unknown keys

export const leavePeriodDeleteSchema = z.object({
  id: z.string().trim().min(1).max(64),
}).strict();

/** P28 (LV-02/LV-03) — the leave policy set master + assignment payloads.
 * The set's SEMANTICS (item count bounds, per-item dedupe, the 0–365
 * allocation bound) are the pure kernel's own refusals
 * (lib/leave/leave-policy-set.ts validatePolicySet); zod carries the structural
 * pass only. */
export const leavePolicySetItemSchema = z.object({
  leaveTypeId: z.string().trim().min(1).max(64),
  annualDays: z.number().min(0).max(365),
}).strict();

export const leavePolicySetCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).default(""),
  items: z.array(leavePolicySetItemSchema).min(1).max(40),
}).strict(); // reject unknown keys

export const leavePolicySetUpdateSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).default(""),
  active: z.boolean(),
  items: z.array(leavePolicySetItemSchema).min(1).max(40),
}).strict(); // reject unknown keys

export const leavePolicySetDeleteSchema = z.object({
  id: z.string().trim().min(1).max(64),
}).strict();

export const leavePolicyAssignmentDeleteSchema = z.object({
  id: z.string().trim().min(1).max(64),
}).strict();

/** The bulk tool (P14's shape): one set, one target bucket, 1–200
 * employees, each in their own transaction (per-employee isolation). */
export const bulkAssignLeavePolicySetSchema = z.object({
  setId: z.string().trim().min(1).max(64),
  bucketYear: z.number().int().min(2020).max(2100),
  userIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
}).strict(); // reject unknown keys

export const createLeaveRequestSchema = z.object({
  leaveTypeId: cuidish,
  startDate: isoDateStr,
  endDate: isoDateStr,
  reason: z.string().trim().max(500).optional(),
}).strict();

export const decideLeaveRequestSchema = z.object({
  requestId: cuidish,
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
}).strict();

export const cancelLeaveRequestSchema = z.object({
  requestId: cuidish,
}).strict();

export const leaveTypeSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(50),
  code: z.string().trim().min(1, "Code is required.").max(20).regex(/^[A-Z_]+$/, "Code must be UPPER_CASE letters/underscores."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #rrggbb hex value.").default("#8b5cf6"),
  requiresDoc: z.boolean().default(false),
  paid: z.boolean().default(true),
  // P15 (PR-06) — partially-paid leave: the fraction of daily salary paid
  // per leave day (paid types only). Default 1 = fully paid = the pre-P15
  // semantics byte-for-byte; 1% steps keep the LOP charge clean (the dock
  // is (1 − fraction) working days per day taken).
  salaryFraction: z.number().min(0, "Salary fraction can't be negative.").max(1, "Salary fraction can't exceed 1 (fully paid).")
    .refine((n) => Math.round(n * 100) === n * 100, "Salary fraction moves in 1% steps (0–1).")
    .default(1),
  active: z.boolean().default(true),
  // P30 (LV-01) — the benchmark's is_optional_leave / is_compensatory type
  // flags (both default false = the pre-P30 behavior byte-for-byte).
  isOptionalLeave: z.boolean().default(false),
  isCompensatory: z.boolean().default(false),
  // F2.4 — the allocation strategy block (docs/Fernly_Policy_Engine_Design.md
  // §4.1). Every default reproduces the pre-F2.4 behavior exactly, so a
  // request that sends only the four legacy knobs is valid and identical.
  policy: z.object({
    annualDays: z.number().min(0).max(365),
    maxCarryOver: z.number().min(0).max(365),
    minNoticeDays: z.number().int().min(0).max(90),
    maxConsecutiveDays: z.number().int().min(1).max(365),
    allocationStrategy: z.enum(["MANUAL", "ANNUAL_LUMP_SUM", "EARNED", "AFTER_SERVICE"]).default("MANUAL"),
    accrualFrequency: z.enum(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"]).default("MONTHLY"),
    allocateOnDay: z.enum(["FIRST", "LAST", "DOJ_DAY"]).default("FIRST"),
    accrualRounding: z.enum(["FLOOR_QUARTER", "NEAREST"]).default("FLOOR_QUARTER"),
    accrualCap: z.number().min(0).max(365).nullable().default(null),
    grantOn: z.enum(["PERIOD_START", "ANNIVERSARY"]).default("PERIOD_START"),
    prorateForJoiners: z.boolean().default(true),
    minServiceMonths: z.number().int().min(0).max(600).default(0),
    accrueDuringProbation: z.boolean().default(true),
    allowNegative: z.boolean().default(false),
    negativeFloor: z.number().min(0).max(365).default(0),
    carryExpiresAfterMonths: z.number().int().min(1).max(24).nullable().default(null),
    countHolidaysInLeave: z.boolean().default(false),
    // P2 (LV-09, F2.2) — encashment knobs (default off = zero behavior).
    encashable: z.boolean().default(false),
    maxEncashableDays: z.number().min(0).max(365).default(5),
    nonEncashableDays: z.number().min(0).max(365).default(5),
    // P30 (LV-01) — the optional-holiday count cap (the benchmark's Max
    // Days Leave Allowed; null = no cap).
    maxOptionalHolidaysPerYear: z.number().int().min(1).max(365).nullable().default(null),
  }).strict(),
}).strict();

export const updateLeaveTypeSchema = leaveTypeSchema.partial();

// LV-10 (S9) — the HR leave adjustment writer. Deltas are signed days
// (quarter-day steps like every leave fraction); the reason is REQUIRED —
// an adjustment without a recorded why is exactly the silent drift the
// ledger exists to prevent.
export const adjustLeaveBalanceSchema = z.object({
  userId: cuidish,
  leaveTypeId: cuidish,
  year: z.number().int().min(2020).max(2100),
  delta: z.number().refine((n) => n !== 0, "An adjustment must be non-zero.")
    .refine((n) => Math.abs(n) <= 365, "Adjustments are capped at 365 days.")
    .refine((n) => Math.round(n * 4) === n * 4, "Adjustments move in quarter-day steps."),
  reason: z.string().trim().min(3, "A reason is required — adjustments are audited corrections.").max(500),
}).strict();

// P21 (LV-R01) — the employee leave balance report filters. All optional:
// the unfiltered shape is the whole workspace for the current year.
export const leaveBalanceReportSchema = z.object({
  year: z.number().int().min(2020).max(2100).optional(),
  userId: cuidish.optional(),
  leaveTypeId: cuidish.optional(),
}).strict();

// P2 (LV-09, F2.2) — leave encashment request + decision. The semantic
// matrix (encashable flag, quarter steps, per-request cap, balance floor)
// lives in the pure planLeaveEncashment kernel; these are shape rules.
export const requestLeaveEncashmentSchema = z.object({
  leaveTypeId: cuidish,
  days: z.number()
    .refine((n) => n > 0, "Encashment needs a positive number of days.")
    .refine((n) => n <= 365, "Encashment is capped at 365 days.")
    .refine((n) => Math.round(n * 4) === n * 4, "Encashment moves in quarter-day steps."),
  payoutPeriod: z.string().trim().regex(PAYROLL_PERIOD_RE, "Pick a payout month (YYYY-MM)."),
  reason: z.string().trim().max(500).default(""),
}).strict();

export const decideLeaveEncashmentSchema = z.object({
  encashmentId: cuidish,
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).default(""),
}).strict();

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — compensatory leave requests (the worked-holiday
// claim). The span's every day must be a weekend/holiday with worked
// attendance (the pure kernel + the action's facts decide); the schema only
// pins the wire shape.
// ---------------------------------------------------------------------------

export const createCompLeaveRequestSchema = z.object({
  leaveTypeId: cuidish,
  workFromDate: isoDateStr,
  workToDate: isoDateStr,
  reason: z.string().trim().max(500).default(""),
}).strict();

export const decideCompLeaveRequestSchema = z.object({
  compId: cuidish,
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).default(""),
}).strict();
