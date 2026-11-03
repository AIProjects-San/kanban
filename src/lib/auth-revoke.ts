// ---------------------------------------------------------------------------
// PR-48 — session-revocation bridge (auth migration Phase 1, §6 port map).
//
// The v4 stack revokes sessions by bumping User.tokenVersion (the jwt
// callback notices within ≤5 min). The Better Auth stack revokes by DELETING
// the user's DB session rows — immediate for lookups, ≤5 min for the cookie
// cache (same worst-case window as v4).
//
// Every flow that bumps tokenVersion calls `revokeUserSessionsIfActive()`
// right after, so BOTH stacks stay revoked in the parallel period. The
// dynamic import keeps the Better Auth instance out of the v4-mode
// server-action bundles; the function is a no-op while
// NEXT_PUBLIC_AUTH_STACK=nextauth.
// ---------------------------------------------------------------------------

import { isBetterAuthStack } from "@/lib/auth-stack";

export async function revokeUserSessionsIfActive(userId: string): Promise<void> {
  if (!isBetterAuthStack()) return;
  const { revokeUserSessions } = await import("@/lib/auth-better");
  await revokeUserSessions(userId);
}
