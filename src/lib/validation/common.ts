// ---------------------------------------------------------------------------
// Runtime input validation for server actions — the shared zod kit.
//
// TypeScript types vanish at runtime — every "use server" export is a public
// HTTP endpoint, so untrusted payloads must be validated before they reach
// the database. Schemas are intentionally permissive about enum VALUES
// (status strings are config-driven) but strict about shape and length.
//
// This module owns the primitives every domain schema file builds on (ids,
// dates, emails, bounded strings) and the parse/throw helpers the actions
// share. The domain schemas live beside this file; the barrel
// (lib/validation/index.ts) re-exports everything as "@/lib/validation".
// ---------------------------------------------------------------------------

import { z } from "zod";

export const cuidish = z.string().min(1).max(64);
export const isoDate = z.string().min(4).max(40);
export const title = z.string().trim().min(1, "Title is required.").max(200);
export const text = z.string().max(10_000);
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "A valid email is required.");

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

export const isoDateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Date must be a real calendar date.");
