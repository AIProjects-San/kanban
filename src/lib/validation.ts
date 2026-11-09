// ---------------------------------------------------------------------------
// Runtime input validation for server actions.
//
// TypeScript types vanish at runtime — every "use server" export is a public
// HTTP endpoint, so untrusted payloads must be validated before they reach
// the database. Schemas are intentionally permissive about enum VALUES
// (status strings are config-driven) but strict about shape and length.
// ---------------------------------------------------------------------------

import { z } from "zod";

import { parsePayrollPeriodKey, PAYROLL_FREQUENCY_VALUES } from "@/lib/payroll-windows";

const cuidish = z.string().min(1).max(64);
const isoDate = z.string().min(4).max(40);
const title = z.string().trim().min(1, "Title is required.").max(200);
const text = z.string().max(10_000);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "A valid email is required.");

export const createTaskSchema = z.object({
  title,
  description: text.optional(),
  status: z.string().max(40).optional(),
  priority: z.string().max(20).optional(),
  tag: z.string().max(40).optional(),
  dueDate: isoDate.nullable().optional(),
  projectId: cuidish.nullable().optional(),
  assigneeId: cuidish.nullable().optional(),
  // Board enhancement — required (estimated) time in minutes. Bounded to a
  // full working week + change so a typo can't write nonsense.
  estimateMinutes: z.number().int().finite().min(0).max(10_080).optional(),
});

export const updateTaskSchema = createTaskSchema.partial();

// Deep-dive review F-10 — moveTask writes status + order directly; give them
// the same shape/length guarantees the create/update schemas enforce.
export const moveTaskSchema = z.object({
  status: z.string().trim().min(1, "Status is required.").max(40),
  order: z.number().int("Order must be an integer.").min(0).max(1_000_000_000),
});

// Deep-dive review F-10 — bulk task patches take the same permissive-enum /
// strict-shape stance as createTaskSchema.
export const bulkTaskPatchSchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  assigneeId: cuidish.nullable().optional(),
});

export const createProjectSchema = z.object({
  name: title,
  description: text.optional(),
  status: z.string().max(40).optional(),
  priority: z.string().max(20).optional(),
  dueDate: isoDate.nullable().optional(),
  color: z.string().max(30).optional(),
  ownerMemberId: z.string().max(64).optional(),
});

// Deep-dive review F-11 — updateProject previously accepted unvalidated
// payloads (unbounded strings, unclamped progress). Same fields as create,
// all optional, plus the progress percent.
export const updateProjectSchema = createProjectSchema.partial().extend({
  progress: z.number().int("Progress must be an integer.").min(0).max(100).optional(),
});

export const createMemberSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  role: z.string().max(120),
  department: z.string().max(60),
  email,
  avatarColor: z.string().max(30).optional(),
  online: z.boolean().optional(),
});

// Deep-dive review F-11 — updateMember previously bypassed the schema the
// create path enforces (email format/case, length caps).
export const updateMemberSchema = createMemberSchema.partial();

export const createEventSchema = z.object({
  title,
  description: text.optional(),
  date: isoDate,
  time: z.string().max(10).optional(),
  durationMin: z.number().int().min(5).max(24 * 60).optional(),
  type: z.string().max(40).optional(),
  location: z.string().max(200).optional(),
});

export const sendMessageSchema = z.object({
  // L-P0-2: direction is now DERIVED per viewer (recipientUserId === me ?
  // "IN" : "OUT") and is no longer authoritative. The field is kept optional
  // in the schema for backward-compat with callers that still pass it, but
  // the value is IGNORED — sendMessage always writes "OUT" at write time.
  direction: z.enum(["IN", "OUT"]).optional(),
  threadId: z.string().max(80).optional(),
  memberId: cuidish.nullable().optional(),
  // Deep-dive review F-08 — sender identity fields are accepted for
  // backward-compat but IGNORED server-side (derived from the session).
  senderName: z.string().max(120).optional(),
  senderAvatarColor: z.string().max(30).optional(),
  senderRole: z.string().max(60).optional(),
  // Display fallback for roster-only recipients (no User account); the real
  // name is resolved from recipientUserId when present.
  recipientName: z.string().max(120).optional(),
  recipientUserId: z.string().max(64).optional(),
  subject: z.string().trim().min(1, "Subject is required.").max(200),
  body: z.string().trim().min(1, "Message body is required.").max(10_000),
});

export const createReminderSchema = z.object({
  title,
  dueDate: isoDate,
});

export const emailSchema = email;

// ---------------------------------------------------------------------------
// Deep-dive review F-01 / F-11 — self-service + settings payloads that
// previously reached Prisma unvalidated.
// ---------------------------------------------------------------------------

// updateProfile: NOTE — there is deliberately NO `role` field. User.role is
// the RBAC role (ADMIN | MANAGER | MEMBER); a client-supplied value here was
// a privilege-escalation vector (any signed-in user could self-promote).
// Job titles live on TeamMember.role and are edited via member:edit paths.
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  timezone: z.string().trim().min(1).max(64),
  bio: z.string().max(2_000),
  avatarColor: z.string().max(30),
});

export const updateUserSettingsSchema = z.object({
  accent: z.string().max(30).optional(),
  dark: z.boolean().optional(),
  sidebarRail: z.boolean().optional(),
  notifEmail: z.boolean().optional(),
  notifPush: z.boolean().optional(),
  notifMentions: z.boolean().optional(),
  notifDueToday: z.boolean().optional(),
  notifWeekly: z.boolean().optional(),
  notifProduct: z.boolean().optional(),
});

export const logTimeSchema = z.object({
  projectId: z.string().trim().min(1, "Project is required.").max(64),
  date: isoDate,
  hours: z.number().finite("Hours must be a number.").refine(
    (h) => h > 0 && h <= 24,
    "Hours must be greater than 0 and at most 24.",
  ),
  description: z.string().max(2_000).optional(),
});

// Board enhancement — task-level time log (required vs spent). The member
// is ALWAYS derived from the session server-side (never client-supplied).
export const logTaskTimeSchema = z.object({
  taskId: cuidish,
  date: isoDate,
  hours: z.number().finite("Hours must be a number.").refine(
    (h) => h > 0 && h <= 24,
    "Hours must be greater than 0 and at most 24.",
  ),
  description: z.string().max(2_000).optional(),
}).strict();

// ---------------------------------------------------------------------------
// P1 (production-readiness re-audit) — workspace settings + config-item
// schemas. The prior implementation accepted `Record<string, unknown>` and
// passed it straight to Prisma, so a typo or a compromised admin session
// could write arbitrary fields (including CSS injection via accentClass).
// These schemas pin the allowed fields + their bounds.
// ---------------------------------------------------------------------------

export const workspaceSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultTimezone: z.string().trim().max(64).optional(),
  defaultUserRole: z.enum(["ADMIN", "MANAGER", "MEMBER"]).optional(),
  defaultDepartment: z.string().trim().max(64).optional(),
  defaultAvatarColor: z.string().trim().max(64).optional(),
  defaultJobTitle: z.string().trim().max(120).optional(),
  // minPasswordLength has a read-time floor of 8 (password.ts); enforce the
  // same bound at write time so a typo can't set it to 1.
  minPasswordLength: z.number().int().finite().min(8).max(128).optional(),
  workloadFullCapacity: z.number().int().finite().min(1).max(100).optional(),
  auditLogLimit: z.number().int().finite().min(1).max(10_000).optional(),
  // auditRetentionDays has a read-time floor of 30; enforce here too.
  auditRetentionDays: z.number().int().finite().min(30).max(3650).optional(),
  entityHistoryLimit: z.number().int().finite().min(1).max(1000).optional(),
  dashboardNotifLimit: z.number().int().finite().min(1).max(200).optional(),
  // F2.10 (F-R9/E5) — the joining-gate toggle (Settings → General).
  joiningGateEnabled: z.boolean().optional(),
  // AT-B02/B03 (S2) — the reference day for late/early flags + working
  // hours. Same HH:MM shape the attendance form already uses.
  attendanceDayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Day start must be HH:MM (24-hour clock).").optional(),
  attendanceDayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Day end must be HH:MM (24-hour clock).").optional(),
  // PR-B07 (S4) — consider_unmarked_attendance_as. IGNORED keeps the
  // pre-S4 semantics (unmarked days never charge LOP).
  unmarkedAttendanceMode: z.enum(["IGNORED", "ABSENT"]).optional(),
  // PR-B23 (S7) — the payslip rounding policy (default ROUND_2DP).
  payrollRoundingMode: z.enum(["ROUND_2DP", "ROUND_NET_NEAREST"]).optional(),
  // P9 (PR-B26) — pay attendance overtime into payroll (default OFF).
  overtimePayEnabled: z.boolean().optional(),
  // P16 (PR-11) — the month the fiscal year starts (1–12; 1 = calendar
  // year = the pre-P16 YTD basis byte-for-byte).
  fiscalYearStartMonth: z.number().int().finite().min(1).max(12).optional(),
  // P17 (PR-B27) — the proration basis switch (default HYBRID = leave-wins
  // = the pre-P17 semantics).
  lopBasisMode: z.enum(["HYBRID", "LEAVE", "ATTENDANCE"]).optional(),
  // P17 (PR-B25) — show live leave balances on the payslip (default OFF).
  showLeaveBalancesOnSlip: z.boolean().optional(),
  // P18 (PR-B16) — email each payslip when its run locks (default OFF =
  // the pre-P18 silence; one PAYSLIP outbox row per slip on lock).
  emailPayslipsOnLock: z.boolean().optional(),
}).strict(); // reject unknown keys

/**
 * Schema for the config-item tables (taskStatusConfig, projectStatusConfig,
 * eventTypeConfig, taskTagConfig, priorityConfig, departmentConfig). All
 * share the same shape: a key, label, optional accent/badge classes, and a
 * sort order. The accent/badge fields are CSS class strings used in the UI;
 * we bound their length so they can't carry an arbitrary payload.
 */
export const configItemSchema = z.object({
  key: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  accent: z.string().trim().max(120).optional(),
  badgeClass: z.string().trim().max(120).optional(),
  dot: z.string().trim().max(120).optional(),
  bg: z.string().trim().max(120).optional(),
  sortOrder: z.number().int().finite().min(0).max(10_000).optional(),
  isSystem: z.boolean().optional(),
}).strict(); // reject unknown keys

// ---------------------------------------------------------------------------
// Bug tracking schemas — QA raises bugs; developers work them through a
// lifecycle. Every field is bounded; status/severity/priority/resolution
// are enums so a typo can't write an orphan string.
// ---------------------------------------------------------------------------

export const createBugSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  description: z.string().max(10_000).optional(),
  stepsToReproduce: z.string().max(10_000).optional(),
  expectedBehavior: z.string().max(5_000).optional(),
  actualBehavior: z.string().max(5_000).optional(),
  severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "TRIVIAL"]).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  projectId: cuidish.nullable().optional(),
  taskId: cuidish.nullable().optional(),
  environment: z.string().trim().max(500).optional(),
}).strict();

export const updateBugSchema = createBugSchema.partial();

export const changeBugStatusSchema = z.object({
  status: z.enum(["NEW", "TRIAGED", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]),
  resolution: z.enum(["FIXED", "WONT_FIX", "DUPLICATE", "CANNOT_REPRODUCE", "WORKS_AS_INTENDED"]).optional(),
  comment: z.string().max(5_000).optional(),
}).strict();

export const assignBugSchema = z.object({
  assigneeUserId: cuidish.nullable(),
}).strict();

// Board enhancement — drag-and-drop bug move on the bug board. Mirrors
// moveTaskSchema: strict shape, enum-bounded status, sane integer order.
export const moveBugSchema = z.object({
  status: z.enum(["NEW", "TRIAGED", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]),
  order: z.number().int("Order must be an integer.").min(0).max(1_000_000_000),
  resolution: z.enum(["FIXED", "WONT_FIX", "DUPLICATE", "CANNOT_REPRODUCE", "WORKS_AS_INTENDED"]).optional(),
}).strict();

// Board enhancement — link (or unlink, with null) a bug to a task.
export const linkBugTaskSchema = z.object({
  taskId: cuidish.nullable(),
}).strict();

export const createBugCommentSchema = z.object({
  bugId: cuidish,
  body: z.string().trim().min(1, "Comment cannot be empty.").max(5_000),
}).strict();

/**
 * Parse `input` against `schema`, throwing an AuthorizationError-compatible
 * Error whose message is safe to show to the user.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const message = first?.message ?? "Invalid input.";
    throw validationError(
      `${message}${first?.path?.length ? ` (${first.path.join(".")})` : ""}`,
    );
  }
  return result.data;
}

/**
 * Build an Error flagged as a validation failure — `isActionError()` on the
 * client recognizes the name and surfaces the message to the user.
 */
export function validationError(message: string): Error {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

// ---------------------------------------------------------------------------
// HR module — leave management (docs/HR_MODULE_PLAN.md §4). Dates arrive as
// ISO date strings (yyyy-mm-dd) from <input type="date">; the actions
// normalize to UTC midnight before computing working days.
// `isoDateStr` also rejects impossible calendar dates ("2026-02-30") that
// pass the regex — before the QA-10b/QA-11b refinement these only blew up
// at the Prisma write with a generic "unexpected failure" (or silently
// compared as NaN).
// ---------------------------------------------------------------------------

const isoDateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Date must be a real calendar date.");

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
  }).strict(),
}).strict();

export const updateLeaveTypeSchema = leaveTypeSchema.partial();

// ---------------------------------------------------------------------------
// F1.1 — holiday calendar (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
// One entry per date; kind is labeling (both kinds exclude the date from
// working-day counting). Label is optional — a bare date is a valid off-day.
// ---------------------------------------------------------------------------

export const holidayEntrySchema = z.object({
  id: cuidish.optional(),
  date: isoDateStr,
  label: z.string().trim().max(80).default(""),
  kind: z.enum(["PUBLIC", "WEEKLY_OFF"]).default("PUBLIC"),
  isHalfDay: z.boolean().default(false),
}).strict();

export const deleteHolidayEntrySchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// F1.3 — attendance records (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). One record per user per date; HR/admin marking only
// (attendance:manage — decision §9.1: no member self-marking). The form
// schema deliberately EXCLUDES ON_LEAVE: that status is derived server-side
// from approved leave and can never be submitted. inTime/outTime are
// optional "HH:mm" clock strings (the <input type="time"> native format);
// when both are present, outTime must be after inTime.
// ---------------------------------------------------------------------------

const hhmmStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm (24-hour clock).");

export const attendanceRecordSchema = z.object({
  id: cuidish.optional(),
  userId: cuidish,
  date: isoDateStr,
  status: z.enum(["PRESENT", "ABSENT", "HALF_DAY", "WFH"]),
  inTime: hhmmStr.nullable().optional(),
  outTime: hhmmStr.nullable().optional(),
  note: z.string().trim().max(500).default(""),
}).strict().refine(
  (v) => !(v.inTime && v.outTime && v.outTime <= v.inTime),
  "Out time must be after in time.",
);

export const deleteAttendanceRecordSchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 2 — employee directory (docs/HR_MODULE_PLAN.md §5).
// `notes` is HR-only and excluded from the self-service schema on purpose.
// ---------------------------------------------------------------------------

const isoDateish = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd.")
  // QA-10b: the regex alone accepts impossible dates ("2026-02-30",
  // "9999-99-99") which only exploded later at the Prisma write with a
  // generic "unexpected failure". Reject them at the schema boundary.
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Date must be a real calendar date.")
  .nullable()
  .optional();

export const employeeProfileSchema = z.object({
  jobTitle: z.string().trim().max(100).optional(),
  // QA-19: "" is the "not classified yet" value (roster renders "—") — the
  // admin path may save a profile without picking a department. Every other
  // unknown string stays rejected.
  department: z.enum(["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"]).or(z.literal("")).optional(),
  hireDate: isoDateish,
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(100).optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  skills: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  // F1.6 — the three PLAIN employment facts are HR-editable here; the
  // STATUS itself is deliberately NOT in this schema (.strict() rejects
  // it): employmentStatus is only writable through the guarded
  // transitionEmployment action (§9.3 hard gate + audit), never a plain
  // profile save.
  probationEndsAt: isoDateish,
  // S14 (EM-B04/LV-B13) — the leave-approver override (null clears it).
  leaveApproverId: cuidish.nullable().optional(),
  noticePeriodWeeks: z
    .number({ message: "Notice period must be a number of weeks." })
    .int("Notice period must be a whole number of weeks.")
    .min(0, "Notice period cannot be negative.")
    .max(52, "Notice period cannot exceed 52 weeks.")
    .nullable()
    .optional(),
  lastWorkingDay: isoDateish,
}).strict();

export const employeeProfileAdminSchema = employeeProfileSchema; // notes included above

// QA-10: self-service may only edit CONTACT fields — job data (jobTitle,
// department, hireDate, notes) is HR-owned per docs/HR_MODULE_PLAN.md §5
// ("Self-service edit of own contact fields; HR/ADMIN edit everything").
// Before this schema existed the self-service action accepted jobTitle /
// department / hireDate, so any member could self-certify "CTO" in the
// shared directory. .strict() rejects any attempt to smuggle HR-owned
// keys through the self-service path.
export const employeeProfileSelfSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(100).optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  skills: z.string().trim().max(500).optional(),
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 3 — performance reviews (docs/HR_MODULE_PLAN.md §6).
// ---------------------------------------------------------------------------

export const createReviewSchema = z.object({
  userId: cuidish,
  title: z.string().trim().min(1, "Title is required.").max(200),
  periodStart: isoDateStr,
  periodEnd: isoDateStr,
  // F1.6 — probation cycles satisfy the §9.3 hard gate once reviewed;
  // omitted keeps the pre-existing STANDARD behavior.
  kind: z.enum(["STANDARD", "PROBATION"]).optional(),
}).strict();

// F1.6 — employment lifecycle transition input (transitionEmployment).
// target is never "": un-classifying is not a transition (one-way — EXITED
// is terminal, and "not tracked" is only the implicit starting state).
export const employmentTransitionSchema = z.object({
  target: z.enum(["PROBATION", "ACTIVE", "SUSPENDED", "EXITED"]),
  probationEndsAt: isoDateish,
  lastWorkingDay: isoDateish,
}).strict();

export const selfAssessmentSchema = z.object({
  reviewId: cuidish,
  selfAssessment: z.string().trim().max(10_000),
  selfRating: z.number().int().min(1, "Rating must be 1-5.").max(5, "Rating must be 1-5.").optional(),
}).strict();

/** Shared id-carrier for the single-id transitions (submit / acknowledge). */
export const reviewDecisionSchema = z.object({
  reviewId: cuidish,
}).strict();

/** Manager decision: comment + 1-5 rating on a SUBMITTED cycle. */
export const decideReviewSchema = z.object({
  reviewId: cuidish,
  managerComment: z.string().trim().min(1, "A comment is required.").max(10_000),
  managerRating: z.number().int().min(1, "Rating must be 1-5.").max(5, "Rating must be 1-5."),
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 4 — onboarding (docs/HR_MODULE_PLAN.md §7).
// ---------------------------------------------------------------------------

export const createChecklistSchema = z.object({
  newHireId: cuidish,
  title: z.string().trim().min(1, "Title is required.").max(200),
  useTemplate: z.boolean().default(true),
  // F2.1 — the same machinery carries separation checklists; the default
  // keeps every existing caller on the onboarding side.
  kind: z.enum(["ONBOARDING", "SEPARATION"]).default("ONBOARDING"),
}).strict();

export const addTaskSchema = z.object({
  checklistId: cuidish,
  title: z.string().trim().min(1, "Task title is required.").max(200),
  assigneeId: cuidish.nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(365).optional(),
}).strict();

export const taskDoneSchema = z.object({
  taskId: cuidish,
  done: z.boolean(),
}).strict();

// F2.10 (F-R8) — the configurable onboarding-template source
// (OnboardingTemplateTask CRUD, onboarding:manage).
export const saveOnboardingTemplateTaskSchema = z.object({
  id: cuidish.optional(),
  kind: z.enum(["ONBOARDING", "SEPARATION"]),
  title: z.string().trim().min(1, "Task title is required.").max(200),
  dueOffsetDays: z.number().int().min(1).max(365),
  assignSelf: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).optional(),
}).strict();

export const deleteOnboardingTemplateTaskSchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// F2.1 — offboarding & full-and-final lite
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2).
// ---------------------------------------------------------------------------

export const exitInterviewCreateSchema = z.object({
  userId: cuidish,
}).strict();

export const exitInterviewScheduleSchema = z.object({
  interviewId: cuidish,
  scheduledAt: isoDateStr,
  interviewerId: cuidish.optional(),
  notes: z.string().trim().max(10_000).optional(),
}).strict();

export const exitInterviewCompleteSchema = z.object({
  interviewId: cuidish,
  notes: z.string().trim().max(10_000).optional(),
}).strict();

export const exitInterviewCancelSchema = z.object({
  interviewId: cuidish,
}).strict();

export const fnfGenerateSchema = z.object({
  userId: cuidish,
}).strict();

export const fnfSettleSchema = z.object({
  userId: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// Recruitment module (docs/RECRUITMENT_MODULE_PLAN.md).
// ---------------------------------------------------------------------------

export const HIRING_STAGE_TYPES = [
  "SCREENING", "INTERVIEW", "ASSESSMENT", "BG_CHECK", "DOCUMENTS", "OFFER", "CUSTOM",
] as const;
// F-R14 (S16) — the exported-but-unused HIRING_STAGE_STATUSES and
// CANDIDATE_STATUSES constants were removed (dead since the hiring
// module's own status machines landed; nothing imported them).

export const saveStageTemplateSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "Stage key is required.").max(60)
    .regex(/^[a-z0-9_]+$/, "Key must be lowercase letters, digits and underscores."),
  label: z.string().trim().min(1, "Stage label is required.").max(120),
  stageType: z.enum(HIRING_STAGE_TYPES),
  ownerRole: z.enum(["ADMIN", "MANAGER", "HR", "MEMBER"]),
  description: z.string().trim().max(500).default(""),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const createCandidateSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  email,
  phone: z.string().trim().max(40).default(""),
  position: z.string().trim().max(120).default(""),
  department: z.string().trim().max(60).default(""),
  source: z.string().trim().max(60).default(""),
  resumeUrl: z.string().trim().max(500).default(""),
  notes: text.default(""),
}).strict();

export const updateCandidateSchema = createCandidateSchema.extend({
  id: cuidish,
}).strict();

export const setStageStatusSchema = z.object({
  stageId: cuidish,
  // PASSED | FAILED | SKIPPED — starting a stage happens via advanceStage.
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  remarks: text.default(""),
}).strict();

export const addCandidateStageSchema = z.object({
  candidateId: cuidish,
  label: z.string().trim().min(1, "Stage label is required.").max(120),
  stageType: z.enum(HIRING_STAGE_TYPES).default("CUSTOM"),
  // Insert before this stage's sort order (null = append at the end).
  beforeStageId: cuidish.nullable().optional(),
}).strict();

export const decideCandidateSchema = z.object({
  candidateId: cuidish,
  // SELECT (R3): ACTIVE → SELECTED — offer prep pointer (offer builder R5).
  decision: z.enum(["SELECT", "REJECT", "WITHDRAW", "REACTIVATE"]),
  // Required for REJECT — audit-only; the email carries HR-approved remarks.
  reason: z.string().trim().max(2_000),
  // R3 — opt-in rejection email. sendEmail: the MailOutbox row is queued and
  // a send is attempted (SENT only when RESEND_API_KEY is wired; SKIPPED in
  // dev dry-run). emailRemarks: the personal note merged into the email.
  sendEmail: z.boolean().default(false),
  emailRemarks: z.string().trim().max(2_000).default(""),
}).strict();

export const deleteStageTemplateSchema = z.object({
  id: cuidish,
}).strict();

export const SCORECARD_RECOMMENDATIONS = ["STRONG_HIRE", "HIRE", "NO_HIRE"] as const;

export const scheduleInterviewSchema = z.object({
  stageId: cuidish,
  // F-R18 (S18) — TWO facts, each on the basis where it is true: the
  // instant (ISO with offset) drives scheduling semantics (clash guard,
  // stage row, reminder); the wall-clock string the user picked (the raw
  // datetime-local value) drives the calendar event's day + label via the
  // pure planInterviewEvent kernel. The shape check here mirrors the
  // kernel's rules (real calendar date + 24-hour ranges land there).
  scheduledAt: z.string().min(4, "A date/time is required.").max(40),
  wallClock: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Wall-clock must be 'YYYY-MM-DDTHH:MM' (a datetime-local value).")
    .max(20),
  interviewerId: cuidish.nullable().optional(),
}).strict();

export const scorecardSchema = z.object({
  stageId: cuidish,
  rating: z.number().int().min(1).max(5).nullable().optional(),
  strengths: z.string().trim().max(2_000).default(""),
  concerns: z.string().trim().max(2_000).default(""),
  recommendation: z.enum(SCORECARD_RECOMMENDATIONS).nullable().optional(),
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

// ---------------------------------------------------------------------------
// R4 — joining formalities: document checklist + background checks
// ---------------------------------------------------------------------------

export const saveDocumentTypeSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "A key is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  description: z.string().trim().max(500).default(""),
  isMandatory: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const deleteDocumentTypeSchema = z.object({
  id: cuidish,
}).strict();

export const requestDocumentSchema = z.object({
  candidateId: cuidish,
  docTypeKey: z.string().trim().min(1).max(60),
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const receiveDocumentSchema = z.object({
  documentId: cuidish,
  // A reference to the received file (URL / name) — optional in v1.
  fileRef: z.string().trim().max(500).default(""),
}).strict();

export const verifyDocumentSchema = z.object({
  documentId: cuidish,
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const rejectDocumentSchema = z.object({
  documentId: cuidish,
  // Required — the candidate/HR needs to know what to fix.
  remarks: z.string().trim().min(1, "A rejection note is required.").max(2_000),
}).strict();

export const BG_CHECK_STATUSES = ["INITIATED", "IN_REVIEW", "CLEARED", "FLAGGED"] as const;

export const initiateBackgroundCheckSchema = z.object({
  candidateId: cuidish,
  vendor: z.string().trim().min(1, "A vendor is required.").max(120),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

export const updateBackgroundCheckSchema = z.object({
  id: cuidish,
  status: z.enum(BG_CHECK_STATUSES),
  reportRef: z.string().trim().max(500).default(""),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

// ---------------------------------------------------------------------------
// R5 — offer builder: templates + per-candidate offers
// ---------------------------------------------------------------------------

// PR-B03 (S8) — STATISTICAL: display-only component (slip info line,
// never money).
export const OFFER_COMPONENT_KINDS = ["EARNING", "EMPLOYER_CONTRIBUTION", "DEDUCTION", "STATISTICAL"] as const;
export const OFFER_COMPONENT_MODES = ["FIXED", "PERCENT_OF_BASIC"] as const;

export const offerComponentSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  kind: z.enum(OFFER_COMPONENT_KINDS),
  mode: z.enum(OFFER_COMPONENT_MODES),
  amount: z.number().min(0).max(100_000_000),
  // PR-B02 (S6) — snapshot of the payment-days exemption (sparse: only
  // false is meaningful; absent = true).
  dependsOnPaymentDays: z.boolean().optional(),
}).strict();

export const saveOfferTemplateSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "A key is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  description: z.string().trim().max(500).default(""),
  components: z.array(offerComponentSchema).max(30),
  benefits: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  letterTemplate: z.string().trim().max(10_000).default(""),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
}).strict();

export const deleteOfferTemplateSchema = z.object({
  id: cuidish,
}).strict();

export const createOfferRecordSchema = z.object({
  candidateId: cuidish,
  templateId: cuidish,
  notes: z.string().trim().max(2_000).default(""),
  // F2.10 (F-R11) — the negotiated start date; feeds {{startDate}}.
  startDate: isoDateStr.optional(),
}).strict();

export const updateOfferRecordSchema = z.object({
  id: cuidish,
  components: z.array(offerComponentSchema).max(30),
  benefits: z.array(z.string().trim().min(1).max(200)).max(30),
  letterText: z.string().trim().max(10_000).default(""),
  notes: z.string().trim().max(2_000).default(""),
  // F2.10 — editable alongside the letter (editing an APPROVED draft
  // demotes it back to DRAFT: re-approval required).
  startDate: isoDateStr.optional(),
}).strict();

// F2.10 — the manager approval step (R11/D-20): DRAFT → APPROVED.
export const approveOfferSchema = z.object({
  offerId: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// R7 — payroll (docs/RECRUITMENT_MODULE_PLAN.md §5). Salary structures reuse
// the offer component schema (annual amounts); payslip lines are monthly
// { key, label, amount } rows; periods are "YYYY-MM".
// ---------------------------------------------------------------------------

export const PAYROLL_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** P10 (PR-B05) — any cadence's period key (2026-11, 2026-11-A, 2026-W45,
 * 2026-F23, 2026-11-09, 2026-Q4, 2026) — the adjustment adapter's target
 * periods accept all of them (lib/payroll-windows.ts is the single
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
}).strict();

// F1.5 — the salary component catalog (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). `code` follows the OfferComponent.key convention (lowercase snake)
// so catalog rows and structure lines join on it. defaultAmount is a
// suggestion by mode: FIXED → annual amount; PERCENT_OF_BASIC → percent of
// the basic anchor (same dual meaning as OfferComponent.amount).
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
}).strict().refine(
  (d) =>
    !d.effectiveFrom || !d.effectiveTo || d.effectiveFrom <= d.effectiveTo,
  { message: "The effective window's start must precede its end." },
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
