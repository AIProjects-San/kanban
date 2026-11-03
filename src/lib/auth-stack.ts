// ---------------------------------------------------------------------------
// PR-48/PR-49 — auth stack flag (client-safe; no "server-only").
//
// NEXT_PUBLIC_AUTH_STACK is the single switch for the auth migration
// (docs/AUTH_MIGRATION_PLAN.md §5). Since the Phase 3 flip (PR-49) the
// DEFAULT is "better": Better Auth 1.7 serves /api/auth-better/* and the
// fernly.* cookies. Setting "nextauth" explicitly re-selects the v4 stack
// — the one-release rollback path — until the post-soak cleanup removes it.
// It is readable by BOTH server and client code, and baked at build time
// for the client.
//
// Client components must import the flag from HERE, never from
// `src/lib/auth-better.ts` (which pulls the whole server stack).
// ---------------------------------------------------------------------------

export type AuthStack = "nextauth" | "better";

export function currentAuthStack(): AuthStack {
  return process.env.NEXT_PUBLIC_AUTH_STACK === "nextauth" ? "nextauth" : "better";
}

export const IS_BETTER_AUTH = currentAuthStack() === "better";

/** Server-side stack check (same source of truth as IS_BETTER_AUTH). */
export function isBetterAuthStack(): boolean {
  return currentAuthStack() === "better";
}
