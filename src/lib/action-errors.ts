// Client-safe helpers for interpreting errors thrown by server actions.
//
// WHY THIS EXISTS: every "use server" export is a remote procedure. In
// development the thrown Error crosses the wire intact; in production
// Next.js may replace the message with a generic one. The `digest` marker
// set by AuthorizationError (and the ValidationError name used by
// lib/validation.ts) survive the boundary, so we can at least classify the
// failure and show a sensible message.

const ACTION_ERROR_DIGESTS = new Set(["AuthorizationError", "ValidationError"]);
const ACTION_ERROR_NAMES = new Set(["AuthorizationError", "ValidationError"]);

/** True when the error is an expected, user-facing action failure. */
export function isActionError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; digest?: unknown };
  return (
    (typeof err.digest === "string" && ACTION_ERROR_DIGESTS.has(err.digest)) ||
    (typeof err.name === "string" && ACTION_ERROR_NAMES.has(err.name))
  );
}

/**
 * Extract the best user-facing message from a server action failure.
 * Falls back to `fallback` for unexpected errors (network, 500s, …).
 */
export function actionErrorMessage(e: unknown, fallback = "Something went wrong."): string {
  if (isActionError(e)) {
    const message = (e as Error).message;
    if (message && !message.startsWith("An unexpected")) return message;
    return "You don't have permission to do that.";
  }
  return fallback;
}
