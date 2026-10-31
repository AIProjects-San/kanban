// ---------------------------------------------------------------------------
// Next.js instrumentation hook + global error handlers.
//
// Next.js auto-loads `src/instrumentation.ts` (or `instrumentation.ts` at the
// root) on server startup, BEFORE any request handler runs. We use it to
// register process-level error handlers so unhandled rejections and uncaught
// exceptions reach the error reporter instead of disappearing into Next's
// default handler (which only console.logs them — they never hit Sentry, and
// the request-id context from AsyncLocalStorage is lost).
//
// Why this matters: server-action rejections are caught by `toResult()` and
// surface as ActionResult errors. But rejections in non-action async paths
// — the JWT refresh callback (auth.ts), the NextAuth signOut event, the
// audit-prune cron — fall through to the Node process's default handler.
// Without these hooks, a wedged DB in the JWT callback would log
// "UnhandledPromiseRejection" to stdout and the user's session would
// silently fail to refresh, with no Sentry event ever firing.
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
// ---------------------------------------------------------------------------

import { captureError, logError } from "@/lib/observability";

/**
 * Next.js calls this once on server startup. We register the global error
 * handlers here (idempotent — if called twice, the second registration
 * replaces the first, which is safe).
 */
export async function register(): Promise<void> {
  // P1 (production-readiness re-audit) — Server Actions CSRF surface.
  // In production the operator MUST set SERVER_ACTIONS_ALLOWED_ORIGINS to
  // their real origin(s). The default fallback in next.config.ts widens to
  // preview domains (*.space-z.ai, *.fcapp.run) which are shared
  // infrastructure — cross-tenant CSRF against Server Actions becomes
  // possible. Refuse to boot here (not in next.config.ts, which also runs
  // at build time) so production servers fail-fast while builds + dev
  // remain unaffected.
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.SERVER_ACTIONS_ALLOWED_ORIGINS
  ) {
    logError(
      "[boot] FATAL: SERVER_ACTIONS_ALLOWED_ORIGINS is unset in production. " +
        "Set it to your real origin(s) — e.g. https://your-domain.example — " +
        "so Server Actions reject cross-origin CSRF. The default fallback " +
        "widens to shared preview domains and is NOT safe for production.",
    );
    process.exit(1);
  }

  // unhandledRejection — a Promise rejected with no .catch() anywhere in
  // its chain. Almost always a bug; we want it in Sentry.
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error
      ? reason
      : new Error(`Unhandled rejection: ${JSON.stringify(reason)}`);
    captureError(err, { source: "unhandledRejection" });
  });

  // uncaughtException — a synchronous throw that escaped all try/catch.
  // The Node.js docs recommend exiting the process after one of these
  // (the app may be in an inconsistent state), so we capture + flush
  // the error to Sentry, then exit non-zero. The container runtime
  // (Docker/k8s) will restart us.
  process.on("uncaughtException", (err: Error) => {
    captureError(err, { source: "uncaughtException" });
    // Give the Sentry fire-and-forget POST a moment to leave the process
    // before we exit. The reporter uses keepalive + a 5s AbortSignal, so
    // 1s is enough for the request to be dispatched.
    setTimeout(() => process.exit(1), 1000).unref();
  });
}
