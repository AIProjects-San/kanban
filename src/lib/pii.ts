// ---------------------------------------------------------------------------
// PII hashing helper — SERVER-ONLY.
//
// This module is intentionally separate from observability.ts because
// observability.ts is imported by the Edge Runtime (via instrumentation.ts
// and proxy.ts), and `node:crypto` is not available in the Edge Runtime.
// hashPii is only needed in server actions (auth.ts, mailer.ts), which run
// in the Node.js runtime — so it lives here, safely away from the edge.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Hashes a PII identifier (email, IP, name) into a short, stable, opaque
 * token for logging. Operators can correlate "is this the same user failing
 * repeatedly?" across log lines without retaining the original identifier.
 *
 * Uses SHA-256 truncated to 8 hex chars (32 bits) — enough to disambiguate
 * users within a single workspace, not enough to be a fingerprint outside
 * one. No salt: the goal is correlation, not password-grade hashing.
 */
export function hashPii(value: string | undefined | null): string {
  if (!value) return "unknown";
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
