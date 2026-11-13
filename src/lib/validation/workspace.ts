// ---------------------------------------------------------------------------
// Workspace + bug-tracking schemas — tasks, projects, members, events,
// messages, reminders, time entries, profile/settings, workspace settings,
// config items, notification templates, and the QA bug lifecycle.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, email, isoDate, text, title } from "./common";


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
  // P21 (LV-T01/LV-T02) — leave email notifications (default OFF = the
  // F-R17 zero-mail posture; LEAVE_PENDING to approvers on request,
  // LEAVE_DECIDED to the requester on decision).
  emailLeaveNotifications: z.boolean().optional(),
  // P25 (PL-02/EM-23) — the engagement digest switches (in-app broadcasts,
  // default ON) + the holiday days-ahead knob (1–30, default 7) + the
  // opt-in email rail (default OFF).
  remindBirthdays: z.boolean().optional(),
  remindAnniversaries: z.boolean().optional(),
  remindHolidays: z.boolean().optional(),
  holidayReminderDaysAhead: z.number().int().finite().min(1).max(30).optional(),
  emailEngagementReminders: z.boolean().optional(),
  // P26 (PL-03/RJ-B18) — the interview nudge switch (in-app, default ON)
  // + its opt-in email rail (default OFF).
  remindInterviews: z.boolean().optional(),
  emailInterviewReminders: z.boolean().optional(),
  // P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft switch
  // (default OFF = the pre-P31 pass is byte-identical; the daily
  // dispatcher's encashment pass drafts one pending LeaveEncashment per
  // encashable pair whose balance exceeds the floor).
  autoLeaveEncashment: z.boolean().optional(),
  // P33 (EM-B02) — the retirement-age display knob (the benchmark's HR
  // Settings retirement_age). Null/omitted = not configured → no
  // projection rendered; 40–80 bounds the age to plausible employment.
  retirementAge: z.number().int().finite().min(40).max(80).nullable().optional(),
}).strict(); // reject unknown keys

/**
 * P24 (PL-01) — the notification template save payload. Structural
 * validation only (non-empty, bounded); the SEMANTIC check — placeholder
 * names must exist in the event's registry vocabulary — lives in the
 * server action, which can name the offending field and the unknown
 * names in a friendly refusal (the QA-18 convention).
 */
export const notificationTemplateSchema = z.object({
  eventKey: z.string().trim().min(1).max(64),
  subject: z.string().trim().min(1).max(250),
  body: z.string().trim().min(1).max(5000),
  title: z.string().trim().min(1).max(250),
  message: z.string().trim().min(1).max(1000),
}).strict(); // reject unknown keys

/** P24 — the reset payload (back to the registry default). */
export const notificationTemplateResetSchema = z.object({
  eventKey: z.string().trim().min(1).max(64),
}).strict();

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
