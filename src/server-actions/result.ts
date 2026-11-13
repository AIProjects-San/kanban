// Server-side helper that turns a throwing action body into an ActionResult.
//
// NOTE: This file intentionally does NOT have "use server" — it exports a
// non-async value and is imported by the action modules, not by clients.

import { logError } from "@/lib/infra/observability";
import { ok, err, isValidationError, isAuthorizationError, type ActionResult } from "@/lib/action-result";

/**
 * Run an action body, catching every failure and converting it into a
 * result object that survives the server→client boundary intact:
 *
 *   - AuthorizationError  → `{ ok: false, code: "AUTH", error: <message> }`
 *   - ValidationError     → `{ ok: false, code: "VALIDATION", error: <message> }`
 *   - anything else       → `{ ok: false, code: "INTERNAL", … }` with a
 *     generic user-facing message (details go to the server log only —
 *     stack traces and Prisma errors must never reach the browser).
 */
export async function toResult<T>(body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await body());
  } catch (e) {
    if (isAuthorizationError(e)) {
      return err("AUTH", e instanceof Error ? e.message : "You must be signed in.");
    }
    if (isValidationError(e) && e instanceof Error) {
      return err("VALIDATION", e.message);
    }
    // Unexpected failure — log it server-side, keep the client message generic.
    logError("[action] unexpected failure:", e);
    return err("INTERNAL", "Something went wrong. Please try again.");
  }
}

/**
 * Validate that a Prisma error is a unique-constraint violation, so callers
 * can surface a friendly CONFLICT message instead of a generic 500.
 */
export function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "P2002"
  );
}
