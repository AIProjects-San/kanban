// ---------------------------------------------------------------------------
// Client → server error bridge (completes L-P1-19).
//
// `src/app/error.tsx` reports client-side errors through
// `window[ERROR_BRIDGE_KEY]` — but until now NOTHING ever assigned that
// function, so client errors silently fell back to console.error only.
// This module installs the bridge. It is imported for its side effect from
// `src/components/providers.tsx` (mounted on every page via the root
// layout's page tree), so the bridge exists before any view can crash.
//
// Design constraints:
//   • Must NOT import `@/lib/infra/observability` (pulls node:async_hooks into
//     the browser bundle — cannot run there). The bridge therefore POSTs
//     to a thin API route which does the server-side capture.
//   • Fire-and-forget (`void fetch`, `keepalive: true`) — error reporting
//     must never itself throw or block rendering.
//   • Payload is capped and generic; no tokens or cookies are attached.
// ---------------------------------------------------------------------------

import { ERROR_BRIDGE_KEY } from "@/config/app";

export interface ClientErrorPayload {
  message: string;
  stack?: string;
  digest?: string;
  source?: string;
  url?: string;
}

type CaptureFn = (error: unknown, meta?: { digest?: string; source?: string }) => void;

const MAX_FIELD_LEN = 2000;

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

function installBridge(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (typeof w[ERROR_BRIDGE_KEY] === "function") return; // idempotent

  w[ERROR_BRIDGE_KEY] = ((error: unknown, meta?: { digest?: string; source?: string }) => {
    try {
      const payload: ClientErrorPayload = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? truncate(error.stack) : undefined,
        digest: truncate(meta?.digest),
        source: truncate(meta?.source),
        url: window.location.href,
      };
      void fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {
        /* best-effort: never let reporting break the page */
      });
    } catch {
      /* best-effort */
    }
  }) satisfies CaptureFn;
}

installBridge();
