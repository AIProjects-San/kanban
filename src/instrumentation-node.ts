// ---------------------------------------------------------------------------
// Node.js-runtime-only instrumentation. Imported dynamically (and only) from
// src/instrumentation.ts when NEXT_RUNTIME === "nodejs", so the Edge bundle
// never compiles this file — see the comment there.
// ---------------------------------------------------------------------------

import { captureError, logError } from "@/lib/infra/observability";

let shuttingDown = false;

/**
 * Next.js calls this once on server startup (Node.js runtime only).
 */
export async function register(): Promise<void> {
  // R-P0-6 (REVIEW_TRIAGE §4.5-6) — Server Actions origins posture: WARN,
  // never block. The earlier P1 guard made an unset value FATAL; the
  // corrected R-P0 batch re-specified the posture as warnings that do not
  // block startup (the production default itself became same-origin-only —
  // next.config.ts + auth-better.ts — so an unset value is SAFE, merely
  // likely-misconfigured behind a proxy, and a warning is the honest
  // severity). The three cases, all non-fatal:
  //   • unset in production            → warning (name the fix)
  //   • the trust-all "*" entry present → LOUD warning (console.error)
  //   • a specific list                 → no warning
  const originsEnv = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? "";
  const origins = originsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === "production") {
    if (!originsEnv) {
      console.warn(
        "[boot] WARNING: SERVER_ACTIONS_ALLOWED_ORIGINS is unset in production — " +
          "Server Actions and Better Auth trust same-origin requests only. " +
          "If clients reach the app through a proxy (a different host than the " +
          "server sees), set it explicitly, e.g. " +
          "SERVER_ACTIONS_ALLOWED_ORIGINS=https://your-production-domain. " +
          "Startup continues.",
      );
    } else if (origins.includes("*")) {
      console.error(
        "[boot] LOUD WARNING: SERVER_ACTIONS_ALLOWED_ORIGINS contains the " +
          "trust-all wildcard '*' — EVERY origin can invoke Server Actions and " +
          "authenticate against Better Auth. This posture must be intentional " +
          "and temporary; remove it and list explicit origins. " +
          "Startup continues — this warning does not block the boot.",
      );
    }
  }

  // P2 — validate origins value (still fatal: a config TYPO is a mistake,
  // not a posture). Accept: real origins (http(s)://host[:port]),
  // localhost, 127.0.0.1. The bare "*" is the loud-warning case above, not
  // a typo — excluded here so it warns without also dying.
  const invalid = origins.filter(
    (o) => o !== "*" && (!o.includes(".") && !o.includes("localhost") && !o.startsWith("127.") && !o.includes(":")),
  );
  if (process.env.NODE_ENV === "production" && invalid.length > 0) {
    console.error(`[boot] FATAL: invalid SERVER_ACTIONS_ALLOWED_ORIGINS: ${invalid.join(", ")}.`);
    process.exit(1);
  }

  // P2 — track graceful-shutdown state.
  const markShuttingDown = () => { shuttingDown = true; };
  process.on("SIGTERM", markShuttingDown);
  process.on("SIGINT", markShuttingDown);

  // P1 — global error handlers.
  try {
    process.on("unhandledRejection", (reason: unknown) => {
      const err = reason instanceof Error
        ? reason
        : new Error(`Unhandled rejection: ${JSON.stringify(reason)}`);
      captureError(err, { source: "unhandledRejection" });
    });
    process.on("uncaughtException", (err: Error) => {
      captureError(err, { source: "uncaughtException" });
      if (shuttingDown) {
        logError("[boot] uncaughtException during graceful shutdown:", err);
        return;
      }
      setTimeout(() => process.exit(1), 1000).unref();
    });
  } catch {
    // Swallow — app can still serve requests without global error capture.
  }
}
