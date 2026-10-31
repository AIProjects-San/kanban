import { NextResponse, type NextRequest } from "next/server";
import { captureError } from "@/lib/observability";

// ---------------------------------------------------------------------------
// Client error ingestion endpoint (completes L-P1-19).
//
// `src/lib/client-error-bridge.ts` (browser) POSTs client-side errors here;
// this route is the server-side half that hands them to the configured
// error reporter with the current request id. The bridge lives in an API
// route because `src/app/error.tsx` cannot import observability directly
// (node:async_hooks must never enter the browser bundle).
//
// Hardening:
//   • POST only; anything else is a bare 405.
//   • Payload capped at 8 KB — a looping client can't flood the logs.
//   • Fields truncated + coerced to strings; no HTML reflection, so the
//     response is a constant and can never echo attacker input.
//   • No-store: reports are not cacheable.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024;

function asString(value: unknown, max = 2000): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * P1 (production-readiness re-audit) — origin check. The endpoint is
 * same-origin only: a malicious third-party site can't flood the operator's
 * error tracker with garbage events. We accept requests whose `Origin`
 * (or `Referer` fallback) matches `APP_URL`, and same-origin requests that
 * carry no `Origin` header (browsers always set it on cross-origin POSTs;
 * same-origin POSTs may omit it). When `APP_URL` is unset we fall back to
 * `NEXTAUTH_URL` so dev environments work without extra config.
 */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const allowed = process.env.APP_URL || process.env.NEXTAUTH_URL;
  if (!allowed) {
    // No allowed origin configured — accept only requests with NO Origin
    // header (same-origin browsers + curl-style probes from the host itself).
    // This is conservative; production MUST set APP_URL.
    return !origin;
  }
  let allowedHost: string;
  try {
    allowedHost = new URL(allowed).host;
  } catch {
    return !origin;
  }
  if (origin) {
    try {
      return new URL(origin).host === allowedHost;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === allowedHost;
    } catch {
      return false;
    }
  }
  // No Origin, no Referer — same-origin browser POST (fetch() with
  // `keepalive` and a relative URL omits Origin). Accept.
  return true;
}

export async function POST(req: NextRequest) {
  // Origin check first — reject cross-site POSTs before any parsing.
  if (!isSameOrigin(req)) {
    return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const body = (parsed ?? {}) as Record<string, unknown>;
  const message = asString(body.message);
  if (!message) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const err = new Error(`[client] ${message}`);
  const stack = asString(body.stack);
  if (stack) err.stack = stack;

  captureError(err, {
    source: asString(body.source, 200) ?? "client-bridge",
    ...(asString(body.digest, 200) ? { digest: asString(body.digest, 200)! } : {}),
    ...(asString(body.url, 500) ? { url: asString(body.url, 500)! } : {}),
  });

  // Constant response — never echo request data back.
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
