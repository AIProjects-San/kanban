"use client";

// L-P1-19 — installs `window[ERROR_BRIDGE_KEY]` so client error boundaries
// (src/app/error.tsx, global-error.tsx) can report to the server-side error
// reporter. Side-effect import: keep it before any view can crash.
import "@/lib/infra/client-error-bridge";

// PR-49 — no session provider is needed on the Better Auth stack:
// authClient.useSession() (src/lib/auth/auth-client-better.ts) is
// nanostores-based and self-fetches (or reads the 5-minute cookie cache
// through get-session), so the component tree needs no provider wrapper.
// The component is kept as the single place that owns the error-bridge
// side-effect import.
export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
