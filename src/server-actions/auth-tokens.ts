"use server";

// ---------------------------------------------------------------------------
// PR-54 — JWT bearer-token issuance.
//
// An authenticated user (via the existing Better Auth cookie session) calls
// `issueAuthToken()` to receive a short-lived JWT. External/programmatic
// clients then pass it as `Authorization: Bearer <token>` on any request;
// getBetterSession() resolves it transparently for every server action and
// API route.
//
// The token is personal — it encodes the signed-in user's identity. It is
// NOT a workspace-wide API key; the same user-scoping rules (getScopedProjectIds,
// member visibility, permission gates) apply to bearer-authenticated requests
// exactly as they do to cookie-authenticated ones, because both paths funnel
// through getSession() → getBetterSession() → the same AuthResult.
//
// Revocation: a soft-deleted user's JWT is immediately inert (the DB lookup
// in getBetterSessionFromJwt rejects deletedAt != null). For password/role
// changes, the existing revokeUserSessions() deletes DB Session rows but
// does NOT invalidate outstanding JWTs — the 1h expiry is the revocation
// window. Re-minting on expiry is the client's responsibility.
// ---------------------------------------------------------------------------

import { getSessionOrThrow } from "./auth-guard";
import { signJwt } from "@/lib/auth/jwt";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { DEFAULT_TOKEN_TTL_SEC } from "@/lib/auth/jwt";

export interface IssuedToken {
  /** The JWT string — pass as `Authorization: Bearer <token>`. */
  token: string;
  /** Unix seconds — when the token expires. Clients should re-mint before
   *  this to avoid a 401 mid-request. */
  expiresAt: number;
  /** Seconds until expiry — convenience for clients setting a refresh timer. */
  expiresIn: number;
  /** The token type for the Authorization header scheme. */
  tokenType: "Bearer";
}

const TOKEN_TTL_SEC = DEFAULT_TOKEN_TTL_SEC;

export async function issueAuthToken(): Promise<ActionResult<IssuedToken>> {
  return toResult(async () => {
    // Cookie-based auth required — this action is the bridge from "you have
    // a browser session" to "you have a bearer token for API access". A
    // caller passing a bearer token to mint another bearer token is a no-op
    // (they already have one); we require the cookie path so token issuance
    // is always rooted in an interactive sign-in.
    const auth = await getSessionOrThrow();
    const token = signJwt(
      {
        sub: auth.userId,
        role: auth.role,
        name: auth.name,
        email: auth.email,
      },
      TOKEN_TTL_SEC,
    );
    const now = Math.floor(Date.now() / 1000);
    return {
      token,
      expiresAt: now + TOKEN_TTL_SEC,
      expiresIn: TOKEN_TTL_SEC,
      tokenType: "Bearer",
    };
  });
}
