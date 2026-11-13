// ---------------------------------------------------------------------------
// Route-level loading skeleton — closes L-P0-3.
//
// Rendered by Next.js while the route segment's server component
// (src/app/page.tsx → getDashboardData) is loading. Replaces the blank white
// page during the (potentially multi-second cross-region) DB round trip.
// Server component (no "use client") so it renders before any client JS.
// ---------------------------------------------------------------------------

import { t } from "@/lib/shared/i18n";
import { APP } from "@/config/app";

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading workspace"
      className="min-h-screen flex items-center justify-center bg-background p-6"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="flex justify-center">
          <div
            className="h-8 w-8 rounded-full border-2 border-muted border-t-primary animate-spin"
            aria-hidden
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("loading.workspace")}
        </p>
        <span className="sr-only">{t("loading.workspaceSr", { app: APP.name })}</span>
      </div>
    </div>
  );
}
