// SERVER-ONLY breached-password check (PR-35, production-readiness round 2
// — roadmap §6.7: "password breach-list check, recommended add-on; requires
// an external dependency the operator should opt into").
//
// Implements the HIBP Pwned Passwords k-anonymity protocol:
//   1. SHA-1 the candidate password locally.
//   2. Send ONLY the first 5 hex chars of the hash to
//      https://api.pwnedpasswords.com/range/<prefix> — the API returns the
//      ~800 hash SUFFIXES sharing that prefix plus breach counts.
//   3. Match the local suffix against the list. The password itself (or its
//      full hash) never leaves the server.
//
// Opt-in contract (deliberate — self-hosted operators decide their egress):
//   • Disabled by default. Enabled by EITHER:
//       PASSWORD_BREACH_CHECK=1            (use the free range API)
//       HIBP_API_KEY=<key>                 (keyed access — recommended for
//                                           sustained production volume)
//   • Fail-open: any network error, timeout (3 s) or non-200 response
//     allows the password and logs `metric=breach_check_failed`. Blocking
//     password changes because a third-party API is down would lock users
//     out of the app — the wrong trade for an add-on control.
//   • Adds ≤ one round trip (typically 100–300 ms) to the four password-SET
//     paths only (self change, admin create, admin reset, self reset).
//     Login never checks — comparing against the breach list at sign-in
//     would leak nothing new and only add latency.
//
// Egress requirement when enabled: api.pwnedpasswords.com:443 (see
// DEPLOY.md §egress).

import { createHash } from "node:crypto";
import { logWarn } from "@/lib/observability";
import { validationError } from "@/lib/validation";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const CHECK_TIMEOUT_MS = 3_000;

/** The message users see when their candidate password is breach-listed. */
export const BREACH_REJECTION_MESSAGE =
  "This password appears in a public data-breach list and cannot be used. " +
  "Choose a different password (a unique passphrase is best).";

export interface BreachCheckResult {
  /** True when the password was found in the breach list. */
  breached: boolean;
  /** False when the check was skipped (disabled) or failed (fail-open). */
  checked: boolean;
}

/** Whether the operator opted into the breach-list check. */
export function isBreachCheckEnabled(): boolean {
  return process.env.PASSWORD_BREACH_CHECK === "1" || !!process.env.HIBP_API_KEY;
}

/**
 * Check a candidate password against HIBP Pwned Passwords (k-anonymity).
 * Never throws — failures fail open (see header).
 */
export async function checkPasswordBreach(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BreachCheckResult> {
  if (!isBreachCheckEnabled()) return { breached: false, checked: false };

  // SHA-1, uppercase — the format the range API returns.
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Fernly-app (breached-password check)",
      // Ask HIBP to pad the response with additional random suffixes so the
      // request volume of small deployments is not distinguishable.
      "Add-Padding": "true",
    };
    if (process.env.HIBP_API_KEY) headers["hibp-api-key"] = process.env.HIBP_API_KEY;

    const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HIBP range API returned ${res.status}`);

    const body = await res.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix === suffix && Number(count) > 0) {
        return { breached: true, checked: true };
      }
    }
    return { breached: false, checked: true };
  } catch (err) {
    logWarn("[breach-check] check failed — allowing the password (fail-open)", {
      metric: "breach_check_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return { breached: false, checked: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Guard for password-SET flows: throws a user-facing ValidationError when
 * the password is breach-listed; no-op when the check is disabled or
 * unavailable (fail-open).
 */
export async function assertPasswordNotBreached(password: string): Promise<void> {
  const result = await checkPasswordBreach(password);
  if (result.breached) {
    throw validationError(BREACH_REJECTION_MESSAGE);
  }
}
