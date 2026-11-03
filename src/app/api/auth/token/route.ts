import { NextResponse } from "next/server";
import { getSession } from "@/server-actions/auth-guard";
import { logAudit } from "@/server-actions/shared";
import { signJwt } from "@/lib/jwt";
import { extractClientIp } from "@/lib/client-ip";
import { headers } from "next/headers";

// ---------------------------------------------------------------------------
// PR-54 — JWT bearer-token minting for non-server-action clients.
//
// `issueAuthToken()` (server action) serves browser-based clients; external
// and programmatic clients (curl, CI, integrations) can't invoke server
// actions cleanly, so this plain HTTP endpoint offers the same minting:
//
//   # 1 — sign in (Better Auth cookie flow), keeping the session cookie:
//   curl -c jar -X POST https://app/api/auth-better/sign-in/email \
//        -H 'content-type: application/json' \
//        -d '{"email":"…","password":"…"}'
//
//   # 2 — exchange the cookie session for a 1-hour bearer token:
//   curl -b jar -X POST https://app/api/auth/token
//   # → { "ok": true, "token": "…", "expiresAt": …, "expiresIn": 3600,
//   #     "tokenType": "Bearer" }
//
//   # 3 — call any server action / API route with the bearer token:
//   curl -H "Authorization: Bearer $TOKEN" https://app/…
//
// Auth: getSession() — accepts EITHER the Better Auth cookie session OR a
// still-valid bearer token (the latter enables refresh-before-expiry: mint
// a new token while the old one is still live). No session → 401.
//
// Security notes:
//   • Same JWT mechanics as src/lib/jwt.ts: HS256, BETTER_AUTH_SECRET,
//     1-hour expiry, constant-time signature comparison.
//   • Every issuance writes an `auth.token_issued` audit row with IP + UA
//     (best-effort — an audit failure never blocks minting), so operators
//     can see who minted API tokens and from where.
//   • Tokens are personal, not workspace API keys: the same scoping rules
//     (getScopedProjectIds, member visibility, permission gates) apply to
//     bearer-authenticated requests exactly as to cookie-authenticated ones,
//     because both paths funnel through getSession() → the same AuthResult.
//   • POST only. GET → 405 (a GET minting tokens would be CSRF-prone and
//     cache-hostile; POST keeps it explicit).
//   • no-store: a minted token must never sit in any cache.
// ---------------------------------------------------------------------------

const TOKEN_TTL_SEC = 60 * 60; // 1 hour — matches signJwt's default.

export async function POST() {
  const auth = await getSession();
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const token = signJwt(
    {
      sub: auth.userId,
      role: auth.role,
      name: auth.name,
      email: auth.email,
    },
    TOKEN_TTL_SEC,
  );

  // Best-effort audit row (logAudit swallows its own failures). IP + UA
  // from the request context, exactly like the sign-in/out rows.
  try {
    const h = await headers();
    const ip = extractClientIp((name) => h.get(name));
    const userAgent = (h.get("user-agent") ?? "unknown").slice(0, 500);
    await logAudit({
      actor: auth,
      action: "auth.token_issued",
      entityType: "AUTH",
      entityLabel: auth.email,
      detail: `${auth.name} minted an API bearer token (1h)`,
      ipAddress: ip,
      userAgent,
    });
  } catch {
    // Never block minting on the audit path.
  }

  const now = Math.floor(Date.now() / 1000);
  return NextResponse.json(
    {
      ok: true,
      token,
      expiresAt: now + TOKEN_TTL_SEC,
      expiresIn: TOKEN_TTL_SEC,
      tokenType: "Bearer",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// GET (and other verbs) are deliberately unsupported — minting is an
// explicit POST. A bare 405 with the Allow header, mirroring the
// client-errors endpoint's method guard.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: "method not allowed" },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
  );
}
