"use client";

// ---------------------------------------------------------------------------
// Global error boundary — closes L-P0-3.
//
// Catches errors that error.tsx cannot — specifically errors thrown in
// root layout.tsx itself. Next.js replaces the ENTIRE document (including
// <html>/<body>) with this file's default export, so it MUST render its own
// <html>/<body> and pull in the global stylesheet so design tokens resolve.
//
// This is the last line of defence — keep it deliberately simple.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { t } from "@/lib/i18n";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/global-error]", error);
  }, [error]);

  return (
    <html lang="en" data-accent="forest">
      <body
        className="antialiased bg-background text-foreground"
        style={{
          fontFamily:
            "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div
          role="alert"
          className="min-h-screen flex items-center justify-center p-6"
        >
          <div className="max-w-md w-full text-center space-y-4">
            <div className="text-5xl" aria-hidden>
              ⚠️
            </div>
            <h1 className="text-2xl font-semibold">
              {t("errors.applicationError")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("errors.applicationErrorBody")}
            </p>
            {error.digest && (
              <p className="text-xs text-muted-foreground/70 font-mono break-all">
                Error ID: {error.digest}
              </p>
            )}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => reset()}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  background: "var(--primary)",
                  color: "var(--primary-foreground)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
