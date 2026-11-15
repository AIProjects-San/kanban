// ---------------------------------------------------------------------------
// G5 — the HTTP push payload parser (the per-vendor seam of the
// /api/biometric/punch endpoint). Parser selection is by device.vendor;
// every vendor without a dedicated parser — i.e. ALL of them today, the
// vendor-specific ones are a follow-up — falls through to the GENERIC
// parser, which speaks the canonical wire shape:
//
//   POST /api/biometric/punch
//   Authorization: Bearer <per-device push token>
//   { "punches": [
//       { "deviceUserId": "1001",
//         "punchedAt": "2026-11-10T09:00:00+13:00",   // zoned ISO or epoch
//         "direction": "IN",                          // IN | OUT | omitted
//         "verifyMethod": "FINGERPRINT" } ] }
//
// A vendor parser's job is only to turn the vendor's native payload into
// the generic punches array; the entry-level validation (ids, timestamps,
// directions) is shared below so no vendor parser can weaken it.
// ---------------------------------------------------------------------------

import {
  normalizeDirection,
  normalizeVerifyMethod,
  parsePunchedAt,
  type PunchDirection,
} from "./punches";

const MAX_PUNCHES_PER_PUSH = 1000;
const MAX_DEVICE_USER_ID = 64;

export interface NormalizedPushPunch {
  deviceUserId: string;
  punchedAt: Date;
  direction: PunchDirection;
  verifyMethod: string | null;
  /** The original entry, verbatim — the audit-grade evidence. */
  rawPayload: Record<string, unknown>;
}

export type PushParseResult =
  | { ok: true; punches: NormalizedPushPunch[] }
  | { ok: false; status: 400; error: string };

/** Extract the raw punch entries from a vendor payload. The generic
 * parser speaks { punches: [...] }; a vendor parser replaces just this
 * step (registered in VENDOR_PARSERS below when vendor info arrives). */
type EnvelopeParser = (body: unknown) => { punches: unknown[] } | { error: string };

const genericEnvelope: EnvelopeParser = (body) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "The body must be a JSON object with a \"punches\" array." };
  }
  const punches = (body as { punches?: unknown }).punches;
  if (!Array.isArray(punches)) {
    return { error: "The \"punches\" array is required." };
  }
  if (punches.length === 0) {
    return { error: "The \"punches\" array is empty." };
  }
  if (punches.length > MAX_PUNCHES_PER_PUSH) {
    return { error: `A push may carry at most ${MAX_PUNCHES_PER_PUSH} punches (got ${punches.length}).` };
  }
  return { punches };
};

/**
 * The vendor parser registry. Vendor-specific parsers (ZKTeco's ADMS
 * JSON, Suprema's, HikVision's …) register here once their wire shapes
 * are confirmed — until then every vendor uses the generic envelope.
 */
const VENDOR_PARSERS: Record<string, EnvelopeParser> = {
  // GENERIC is the documented fallback; listed for discoverability.
  GENERIC: genericEnvelope,
};

function parserForVendor(vendor: string): EnvelopeParser {
  return VENDOR_PARSERS[vendor] ?? genericEnvelope;
}

/** Validate + normalize one push entry against the shared contract
 * (unknown extra fields ride along in rawPayload). */
function normalizeEntry(entry: unknown, index: number): NormalizedPushPunch | { error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { error: `punches[${index}] must be an object.` };
  }
  const raw = entry as Record<string, unknown>;
  const deviceUserId = raw.deviceUserId;
  if (typeof deviceUserId !== "string" || !deviceUserId.trim() || deviceUserId.length > MAX_DEVICE_USER_ID) {
    return { error: `punches[${index}].deviceUserId must be a non-empty string (max ${MAX_DEVICE_USER_ID} characters).` };
  }
  // Naive timestamps read as UTC — the deterministic wire contract
  // (devices that know their zone should send zoned ISO or epoch).
  const punchedAt = parsePunchedAt(raw.punchedAt, { naiveZone: "UTC" });
  if (punchedAt === null) {
    return { error: `punches[${index}].punchedAt must be an epoch number or an ISO timestamp.` };
  }
  const direction = normalizeDirection(raw.direction);
  if (direction === null) {
    return { error: `punches[${index}].direction must be "IN", "OUT" or "UNKNOWN".` };
  }
  if (raw.verifyMethod !== undefined && typeof raw.verifyMethod !== "string") {
    return { error: `punches[${index}].verifyMethod must be a string when present.` };
  }
  return {
    deviceUserId: deviceUserId.trim(),
    punchedAt,
    direction,
    verifyMethod: normalizeVerifyMethod(raw.verifyMethod),
    rawPayload: raw,
  };
}

/**
 * Parse a push body for a vendor: envelope (per-vendor) + entry
 * validation (shared). Strict — one malformed entry rejects the whole
 * push with 400 (the device retries; the ingest-time duplicate guard
 * makes re-delivery idempotent).
 */
export function parsePushPayload(vendor: string, body: unknown): PushParseResult {
  const envelope = parserForVendor(vendor)(body);
  if ("error" in envelope) return { ok: false, status: 400, error: envelope.error };
  const punches: NormalizedPushPunch[] = [];
  for (let i = 0; i < envelope.punches.length; i++) {
    const normalized = normalizeEntry(envelope.punches[i], i);
    if ("error" in normalized) return { ok: false, status: 400, error: normalized.error };
    punches.push(normalized);
  }
  return { ok: true, punches };
}
