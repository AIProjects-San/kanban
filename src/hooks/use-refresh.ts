"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useApp } from "@/store/app-store";

/**
 * Combined refresh hook used by every mutation handler in the app.
 *
 * `router.refresh()` re-runs the current route's server components and
 * re-renders with fresh props — that's how a created task appears on the
 * board without a full page reload. `bumpRefresh()` (Zustand) is layered on
 * top so views that key off `refreshTick` (and modals/drawers that need to
 * re-fetch) also remount with the new data.
 *
 * The audit (Fernly-Launch-Readiness-Audit.docx L-P0-1) found zero
 * `router.refresh()` calls in the codebase — every mutation left stale
 * props and the board reverted. This hook centralises the fix.
 *
 * Use:
 *   const refresh = useRefresh();
 *   await createTask(...);
 *   refresh();
 */
export function useRefresh() {
  const router = useRouter();
  return useCallback(() => {
    // 1. Re-fetch server-component props (this is the missing piece).
    router.refresh();
    // 2. Bump the Zustand tick so views that key off refreshTick also
    //    remount with the fresh props once they land.
    useApp.getState().bumpRefresh();
  }, [router]);
}
