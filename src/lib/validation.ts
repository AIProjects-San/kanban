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
