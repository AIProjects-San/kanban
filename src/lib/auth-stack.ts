// ---------------------------------------------------------------------------
// PR-48 — auth stack flag (client-safe; no "server-only").
//
// NEXT_PUBLIC_AUTH_STACK is the single switch for the auth migration
// (docs/AUTH_MIGRATION_PLAN.md §5): "nextauth" (default — v4 serves
// /api/auth/*) or "better" (the parallel stack at /api/auth-better/* takes
// over). It is readable by BOTH server and client code, and baked at build
// time for the client — flipping it is a deployment action (Phase 3), not a
// runtime toggle.
//
// Client components must import the flag from HERE, never from
// `src/lib/auth-better.ts` (which pulls the whole server stack).
// ---------------------------------------------------------------------------

export type AuthStack = "nextauth" | "better";

export function currentAuthStack(): AuthStack {
  return process.env.NEXT_PUBLIC_AUTH_STACK === "better" ? "better" : "nextauth";
}

export const IS_BETTER_AUTH = currentAuthStack() === "better";

/** Server-side stack check (same source of truth as IS_BETTER_AUTH). */
export function isBetterAuthStack(): boolean {
  return currentAuthStack() === "better";
}
