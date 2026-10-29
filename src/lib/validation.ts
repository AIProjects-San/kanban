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

export const createProjectSchema = z.object({
  name: title,
  description: text.optional(),
  status: z.string().max(40).optional(),
  priority: z.string().max(20).optional(),
  dueDate: isoDate.nullable().optional(),
  color: z.string().max(30).optional(),
  ownerMemberId: z.string().max(64).optional(),
});

export const createMemberSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  role: z.string().max(120),
  department: z.string().max(60),
  email,
  avatarColor: z.string().max(30).optional(),
  online: z.boolean().optional(),
});

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
  direction: z.enum(["IN", "OUT"]),
  threadId: z.string().max(80).optional(),
  memberId: cuidish.nullable().optional(),
  senderName: z.string().max(120),
  senderAvatarColor: z.string().max(30).optional(),
  senderRole: z.string().max(60).optional(),
  recipientName: z.string().max(120),
  recipientUserId: z.string().max(64).optional(),
  subject: z.string().trim().min(1, "Subject is required.").max(200),
  body: z.string().trim().min(1, "Message body is required.").max(10_000),
});

export const createReminderSchema = z.object({
  title,
  dueDate: isoDate,
});

export const emailSchema = email;

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
