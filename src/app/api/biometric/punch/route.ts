import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/infra/db";
import { captureError } from "@/lib/infra/observability";
import { devicePushToken } from "@/lib/biometric/punches";
import { parsePushPayload } from "@/lib/biometric/push-parser";

// ---------------------------------------------------------------------------
// G5 — the biometric punch push endpoint (ADMS-style; works for ANY
// push protocol — the parser seam is per-vendor, see
// lib/biometric/push-parser.ts).
//
// Auth: a per-device token in BiometricDevice.config.pushToken, sent as
// "Authorization: Bearer <token>" or "x-device-token: <token>" —
// constant-time compared against every ACTIVE device (an inactive or
// tokenless device never matches).
//
// Contract: 200 { ok, accepted, duplicates } on success (duplicates =
// exact re-deliveries the DB guard skipped, NOT errors); 401 on a
// missing/unknown token; 400 on a malformed payload (strict — one bad
// entry rejects the push; the duplicate guard makes the retry safe);
// 413 over the body cap. Punches always land as PENDING — mapping and
// derivation are the reconcile engine's job, never the ingest path's.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { "cache-control": "no-store" } as const;

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function unauthorized(): NextResponse {
  return json(401, { error: "Invalid device token." });
}

/** Extract the bearer/x-device-token header value. */
function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const header = req.headers.get("x-device-token");
  if (header && header.trim()) return header.trim();
  return null;
}

/** Constant-time token equality (length mismatches fail fast — only the
 * length is observable, never the token bytes). */
function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function POST(req: Request): Promise<NextResponse> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return json(400, { error: "Unreadable body." });
  }
  if (text.length > MAX_BODY_BYTES) {
    return json(413, { error: "Body too large." });
  }

  const token = tokenFrom(req);
  if (token === null) return unauthorized();

  // Resolve the device by token (active + token-configured devices only —
  // the isActive re-check is defense in depth; the query already filters).
  const devices = await db.biometricDevice.findMany({ where: { isActive: true } });
  const device = devices.find((d) => {
    if (!d.isActive) return false;
    const configured = devicePushToken(d.config);
    return configured !== null && tokensMatch(configured, token);
  });
  if (!device) return unauthorized();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "The body must be valid JSON." });
  }

  const parsed = parsePushPayload(device.vendor, body);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });

  // Ingest: PENDING rows; the (deviceId, deviceUserId, punchedAt)
  // re-delivery guard turns exact duplicates into counts, never errors.
  let accepted = 0;
  let duplicates = 0;
  try {
    for (const p of parsed.punches) {
      try {
        await db.punch.create({
          data: {
            deviceId: device.id,
            deviceUserId: p.deviceUserId,
            punchedAt: p.punchedAt,
            direction: p.direction,
            verifyMethod: p.verifyMethod,
            rawPayload: p.rawPayload as Prisma.InputJsonValue,
          },
        });
        accepted++;
      } catch (e) {
        if ((e as { code?: unknown }).code === "P2002") {
          duplicates++;
          continue;
        }
        throw e;
      }
    }
    if (accepted + duplicates > 0) {
      await db.biometricDevice.update({
        where: { id: device.id },
        data: { lastSyncAt: new Date() },
      });
    }
  } catch (e) {
    captureError(e, { route: "/api/biometric/punch" });
    return json(500, { error: "Could not record the punches." });
  }

  return json(200, { ok: true, accepted, duplicates });
}
