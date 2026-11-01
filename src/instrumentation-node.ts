// ---------------------------------------------------------------------------
// Node.js-runtime-only instrumentation. Imported dynamically (and only) from
// src/instrumentation.ts when NEXT_RUNTIME === "nodejs", so the Edge bundle
// never compiles this file — see the comment there.
// ---------------------------------------------------------------------------

import { captureError, logError } from "@/lib/observability";

let shuttingDown = false;

/**
 * Next.js calls this once on server startup (Node.js runtime only).
 */
export async function register(): Promise<void> {
  // P1 — Server Actions CSRF boot guard.
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.SERVER_ACTIONS_ALLOWED_ORIGINS
  ) {
    console.error(
      "[boot] FATAL: SERVER_ACTIONS_ALLOWED_ORIGINS is unset in production.",
    );
    process.exit(1);
  }

  // P2 — validate origins value. Accept: real origins (http(s)://host[:port]),
  // localhost, 127.0.0.1. Reject: bare "*".
  const origins = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = origins.filter(
    (o) => o === "*" || (!o.includes(".") && !o.includes("localhost") && !o.startsWith("127.") && !o.includes(":")),
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
