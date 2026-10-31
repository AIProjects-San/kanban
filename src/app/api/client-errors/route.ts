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

export async function POST(req: NextRequest) {
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
