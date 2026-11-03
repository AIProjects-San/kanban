// ---------------------------------------------------------------------------
// PR-48/PR-49 — session-revocation bridge (§6 port map).
//
// Revocation on the Better Auth stack works by DELETING the user's DB
// session rows — immediate for lookups, ≤5 min for the cookie cache (the
// same worst-case window the old v4 tokenVersion JWT check had).
//
// Every flow that bumps User.tokenVersion (password change, role change,
// soft-delete, "sign out everywhere") calls `revokeUserSessionsIfActive()`
// right after. The tokenVersion bump itself is retained as a cheap,
// auditable intent marker — the actual kill switch is the row delete here.
// ---------------------------------------------------------------------------

import { revokeUserSessions } from "@/lib/auth-better";

export async function revokeUserSessionsIfActive(userId: string): Promise<void> {
  await revokeUserSessions(userId);
}
