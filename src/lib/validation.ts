// ---------------------------------------------------------------------------
// Runtime input validation for server actions.
//
// TypeScript types vanish at runtime — every "use server" export is a public
// HTTP endpoint, so untrusted payloads must be validated before they reach
// the database. Schemas are intentionally permissive about enum VALUES
// (status strings are config-driven) but strict about shape and length.
// ---------------------------------------------------------------------------

import { z } from "zod";

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
  active: z.boolean().default(true),
  policy: z.object({
    annualDays: z.number().min(0).max(365),
    maxCarryOver: z.number().min(0).max(365),
    minNoticeDays: z.number().int().min(0).max(90),
    maxConsecutiveDays: z.number().int().min(1).max(365),
  }).strict(),
}).strict();

export const updateLeaveTypeSchema = leaveTypeSchema.partial();

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
  department: z.enum(["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"]).optional(),
  hireDate: isoDateish,
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(100).optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  skills: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
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
