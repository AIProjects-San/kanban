"use client";

import { useCallback } from "react";
import { useAppSession } from "@/hooks/use-app-session";
import { updateUserSettings } from "@/server-actions/data";

/**
 * PR-65 — appearance is PER-USER. Every surface that changes appearance
 * (Settings view, ⌘K palette, topbar dark toggle, ⌘B rail toggle, the
 * sidebar rail button) persists the change to the signed-in user's
 * UserSettings row; the Zustand store already drives the immediate UI and
 * the per-user localStorage cache. Best-effort: a failed write never breaks
 * the interaction (the store value still applies for this session).
 */
export function usePersistAppearance() {
  const { data: session } = useAppSession();
  const userId = session?.user?.id;
  return useCallback(
    (patch: { accent?: string; dark?: boolean; sidebarRail?: boolean }) => {
      if (!userId) return;
      void updateUserSettings(userId, patch).catch(() => {
        /* non-critical — the store value still applies for this session */
      });
    },
    [userId],
  );
}
