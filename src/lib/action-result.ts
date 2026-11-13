// Client-safe result types + error classification for server actions.
//
// WHY THIS EXISTS: every "use server" export is a remote procedure. Errors
// thrown across the server→client boundary are unreliable in production
// (Next.js may replace the message with a generic one, and `instanceof`
// checks break across the boundary). Actions therefore RETURN a result
// object instead of throwing, and clients branch on `res.ok`.
//
// The markers that DO survive the boundary — the `digest` AuthorizationError
// sets and the `name` lib/validation's ValidationError carries — are owned
// here so the server classifier (server-actions/result.ts) and the client
// classifier (below) can never drift apart.
//
// This module must stay dependency-free so it can be imported from both
// client components and server actions.

export type ActionErrorCode =
  | "AUTH" // signed out, missing permission, ownership violation
  | "VALIDATION" // user input rejected (zod or manual checks)
  | "NOT_FOUND" // target entity does not exist
  | "CONFLICT" // uniqueness / state conflicts (duplicate email, role in use…)
  | "INTERNAL"; // unexpected server error — details logged server-side only

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = { ok: false; code: ActionErrorCode; error: string };

/** The return type every client-invokable server action uses. */
export type ActionResult<T> = ActionOk<T> | ActionErr;

export function ok<T>(data: T): ActionOk<T> {
  return { ok: true, data };
}

export function err(code: ActionErrorCode, error: string): ActionErr {
  return { ok: false, code, error };
}

/** The error name lib/validation.ts throws (and the digest it carries). */
export const VALIDATION_ERROR_MARKER = "ValidationError";

/** The digest AuthorizationError carries across the boundary. */
export const AUTHORIZATION_ERROR_MARKER = "AuthorizationError";

const ACTION_ERROR_MARKERS = new Set([
  VALIDATION_ERROR_MARKER,
  AUTHORIZATION_ERROR_MARKER,
]);

/** True when the error is an AuthorizationError — the real class, or any
 *  error carrying its boundary marker (the digest survives mocks and the
 *  server→client wire; instanceof alone does not). */
export function isAuthorizationError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; digest?: unknown };
  return (
    err.name === AUTHORIZATION_ERROR_MARKER || err.digest === AUTHORIZATION_ERROR_MARKER
  );
}

/** True when the error is a ValidationError (by name or digest marker). */
export function isValidationError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; digest?: unknown };
  return (
    err.name === VALIDATION_ERROR_MARKER || err.digest === VALIDATION_ERROR_MARKER
  );
}

/** True when the error is an expected, user-facing action failure
 *  (authorisation or validation). */
export function isActionError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; digest?: unknown };
  return (
    (typeof err.digest === "string" && ACTION_ERROR_MARKERS.has(err.digest)) ||
    (typeof err.name === "string" && ACTION_ERROR_MARKERS.has(err.name))
  );
}

/**
 * Extract the best user-facing message from a server action failure.
 * Falls back to `fallback` for unexpected errors (network, 500s, …).
 */
export function actionErrorMessage(e: unknown, fallback = "Something went wrong."): string {
  if (isActionError(e)) {
    const message = (e as Error).message;
    return message || fallback;
  }
  return fallback;
}
