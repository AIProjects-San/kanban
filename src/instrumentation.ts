// ---------------------------------------------------------------------------
// Next.js instrumentation hook — runs in BOTH Node.js + Edge runtime.
//
// The Edge runtime does NOT support `process.on()`, `process.exit()`, or
// `setTimeout` with `.unref()`. We guard ALL Node.js-specific code behind
// a runtime check. The Edge runtime parses the code but never executes the
// guarded paths.
// ---------------------------------------------------------------------------

/**
 * Detects whether we're running in the Node.js Runtime (not Edge).
 * Edge Runtime: `process` exists but `process.versions.node` is undefined.
 */
function isNodeRuntime(): boolean {
  try {
    return typeof (process as { versions?: { node?: string } }).versions?.node === "string";
  } catch {
    return false;
  }
}

let shuttingDown = false;

/**
 * Next.js calls this once on server startup.
 */
export async function register(): Promise<void> {
  if (!isNodeRuntime()) {
    // Edge runtime — no-op.
    return;
  }

  // ---- Node.js runtime only (beyond this point) ----

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

  // P1 — global error handlers (lazy-import observability).
  try {
    process.on("unhandledRejection", (reason: unknown) => {
      const err = reason instanceof Error
        ? reason
        : new Error(`Unhandled rejection: ${JSON.stringify(reason)}`);
      import("@/lib/observability").then(({ captureError }) => {
        captureError(err, { source: "unhandledRejection" });
      });
    });
    process.on("uncaughtException", (err: Error) => {
      import("@/lib/observability").then(({ captureError, logError }) => {
        captureError(err, { source: "uncaughtException" });
        if (shuttingDown) {
          logError("[boot] uncaughtException during graceful shutdown:", err);
          return;
        }
        setTimeout(() => process.exit(1), 1000).unref();
      });
    });
  } catch {
    // Swallow — app can still serve requests without global error capture.
  }
}
