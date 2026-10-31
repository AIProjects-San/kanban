// ---------------------------------------------------------------------------
// 404 not-found boundary — closes L-P0-3.
//
// Rendered by Next.js when a route segment calls `notFound()` or when the
// router cannot match any route to the URL. Server component (no
// "use client") so it renders even if the client bundle is broken.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { t } from "@/lib/i18n";

export default function NotFound() {
  return (
    <div
      role="alert"
      className="min-h-screen flex items-center justify-center bg-background p-6"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-5xl font-mono text-muted-foreground/60" aria-hidden>
          404
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          {t("errors.notFound")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("errors.notFoundBody")}
        </p>
        <div className="pt-2">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors h-9 px-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Back to Fernly
          </Link>
        </div>
      </div>
    </div>
  );
}
