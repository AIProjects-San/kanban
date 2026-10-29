// Client-safe result types for server actions.
//
// WHY THIS EXISTS: every "use server" export is a remote procedure. Errors
// thrown across the server→client boundary are unreliable in production
// (Next.js may replace the message with a generic one, and `instanceof`
// checks break across the boundary). Actions therefore RETURN a result
// object instead of throwing, and clients branch on `res.ok`.
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

/** Type guard for the success branch. */
export function isOk<T>(r: ActionResult<T>): r is ActionOk<T> {
  return r.ok;
}

/** Type guard for the failure branch. */
export function isErr(r: ActionResult<unknown>): r is ActionErr {
  return !r.ok;
}
