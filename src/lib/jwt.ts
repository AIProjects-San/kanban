// ---------------------------------------------------------------------------
// PR-54 — HS256 JWT sign/verify (dependency-free, Node crypto).
//
// Enables bearer-token auth alongside the existing Better Auth cookie
// sessions. An authenticated user calls `issueAuthToken()` (server action)
// to receive a short-lived JWT; external/programmatic clients then pass it
// as `Authorization: Bearer <token>` on any request. getBetterSession()
// checks that header BEFORE the cookie-based fallback, so every server
// action and API route that calls getSession() supports both auth methods
// transparently.
//
// Design:
//   • HS256 (symmetric) — signed and verified by the same server, no
//     key-pair distribution. Uses BETTER_AUTH_SECRET (same env var as the
//     Better Auth stack — one secret to manage).
//   • 1-hour expiry — a stolen token has a narrow window. Shorter than the
//     7-day cookie session because bearer tokens are typically held by
//     automated clients that can re-mint on expiry.
//   • Soft-delete check at verify time — a disabled account's JWT is
//     immediately inert (the DB lookup in getBetterSessionFromJwt rejects
//     deletedAt != null). The cookie path has the same guarantee via
//     Better Auth's session.create backstop + getBetterSession's
//     deletedAt guard.
//   • Revocation: JWTs are stateless, so immediate revocation (before
//     expiry) requires a blocklist (Redis SET of revoked JTIs — future
//     enhancement). The soft-delete check covers the most common
//     revocation case (account disabled). For password/role changes,
//     the existing revokeUserSessions() deletes DB Session rows but does
//     NOT invalidate outstanding JWTs — the 1h expiry is the revocation
//     window. Documented in docs/SECURITY.md §1 (bearer tokens).
//   • No `none` algorithm — verifyJwt rejects any alg != HS256.
//   • Constant-time signature comparison (timingSafeEqual).
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

const JWT_ALG = "HS256";
const JWT_TYP = "JWT";
/** The default bearer-token lifetime — auth-tokens.ts issues with it. */
export const DEFAULT_TOKEN_TTL_SEC = 60 * 60;

/** The dev-fallback secret prefix — shared with auth-better.ts so both
 *  stacks refuse the same weak secrets. */
export const WEAK_SECRET_PREFIX = "fernly-dev-secret";

// Cache the dev-fallback secret so sign + verify use the same ephemeral
// value within a process (matches resolveBetterSecret's module-load
// caching in auth-better.ts — a new UUID per call would make JWTs
// unverifiable across sign→verify).
let cachedDevSecret: string | null = null;

/**
 * Resolve the HMAC signing secret. In production, BETTER_AUTH_SECRET is
 * required (resolveBetterSecret in auth-better.ts throws on a missing/weak
 * secret at boot). In dev/test, an ephemeral UUID is cached for the process
 * lifetime so JWTs round-trip within a single server run.
 */
export function resolveJwtSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret && !secret.startsWith(WEAK_SECRET_PREFIX)) return secret;
  if (!cachedDevSecret) cachedDevSecret = crypto.randomUUID();
  return cachedDevSecret;
}

export interface JwtPayload {
  /** Subject — the User.id this token authenticates. */
  sub: string;
  /** Role at issuance. The DB is authoritative at verify time (role changes
   *  take effect immediately via the getBetterSessionFromJwt DB lookup). */
  role: string;
  name: string;
  email: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
}

/** JWT signing input — the two base64url segments the signature covers. */
function signingInput(headerB64: string, payloadB64: string): string {
  return `${headerB64}.${payloadB64}`;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Sign a JWT (HS256). Returns the compact serialization
 * `base64url(header).base64url(payload).base64url(signature)`.
 */
export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  ttlSec: number = DEFAULT_TOKEN_TTL_SEC,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + ttlSec };
  const header = { alg: JWT_ALG, typ: JWT_TYP };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));
  const input = signingInput(headerB64, payloadB64);
  const signature = createHmac("sha256", resolveJwtSecret()).update(input).digest();
  return `${input}.${base64urlEncode(signature)}`;
}

/**
 * Verify a JWT's signature + expiry. Returns the payload on success, null
 * on any failure (bad format, wrong alg, tampered signature, expired).
 *
 * Does NOT check the user's soft-delete status — that's the caller's job
 * (getBetterSessionFromJwt does the DB lookup). This function is purely
 * cryptographic so it can be tested without DB mocks.
 */
export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  // Header — reject anything that isn't HS256 (closes the `alg: none`
  // confusion attack).
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== JWT_ALG) return null;

  // Signature — constant-time comparison.
  const input = signingInput(headerB64, payloadB64);
  const expected = createHmac("sha256", resolveJwtSecret()).update(input).digest();
  const actual = base64urlDecode(signatureB64);
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  // Payload — decode + validate structure + expiry.
  let payload: Partial<JwtPayload>;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (typeof payload.exp !== "number") return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  // iat is informational (skew detection) but not enforced — clock skew
  // between sign and verify is handled by exp alone.
  if (typeof payload.iat !== "number") return null;
  if (typeof payload.role !== "string") return null;
  if (typeof payload.name !== "string") return null;
  if (typeof payload.email !== "string") return null;

  return payload as JwtPayload;
}
