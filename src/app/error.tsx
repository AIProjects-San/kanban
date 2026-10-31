"use client";

// ---------------------------------------------------------------------------
// Route-level error boundary — closes L-P0-3.
//
// Catches uncaught errors thrown DURING RENDER of the route segment
// (src/app/page.tsx and everything it pulls in). Next.js shows this file's
// default export in place of the broken segment, instead of the raw Next.js
// error page. The audit (§9.4 L-P0-3) called out the absence of any error
// boundary — getDashboardData's deliberate throwing contract had no catcher.
//
// Contract:
//  - MUST be a client component ("use client").
//  - Receives { error, reset } — reset() re-attempts the render.
//  - Must NOT rethrow the error (it would bubble to global-error).
//  - L-P1-19: reports the error to the configured error tracker via
//    `window.__fernlyCaptureError` (a client-safe bridge). Falls back to
//    console.error — importing the observability module directly would pull
//    node:async_hooks into the browser bundle, which cannot run there.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

type CaptureFn = (e: unknown, c?: Record<string, unknown>) => void;

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
    if (typeof window !== "undefined") {
      const capture = (window as unknown as { __fernlyCaptureError?: CaptureFn }).__fernlyCaptureError;
      if (typeof capture === "function") {
        capture(error, { digest: error.digest, source: "app/error.tsx" });
      }
    }
  }, [error]);

  return (
    <div
      role="alert"
      className="min-h-screen flex items-center justify-center bg-background p-6"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-5xl" aria-hidden>
          ⚠️
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="text-sm text-muted-foreground">
          The page hit an unexpected error while loading. Your data is safe —
          you can try again, or reload the workspace.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground/70 font-mono break-all">
            Error ID: {error.digest}
          </p>
        )}
        {process.env.NODE_ENV === "development" && error.message && (
          <pre className="text-xs text-left bg-muted/50 rounded-md p-3 overflow-auto max-h-40 text-muted-foreground">
            {error.message}
          </pre>
        )}
        <div className="flex gap-2 justify-center pt-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors h-9 px-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors h-9 px-4 border border-border bg-background hover:bg-accent hover:text-accent-foreground"
          >
            Reload workspace
          </button>
        </div>
      </div>
    </div>
  );
}
