"use client";

import { useEffect } from "react";
import { useApp } from "@/store/app-store";
import { usePermissions } from "@/hooks/use-permissions";
import { usePersistAppearance } from "@/hooks/use-appearance-sync";
import { navLeaves } from "@/config/navigation";
import type { Permission } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// L-P0-15 — Permission gates for G-prefix view shortcuts.
//
// PR-58 — the view map AND its gates now derive from
// src/config/navigation.ts (the same source the sidebar and ⌘K use), so a
// gated view can no longer be reachable by shortcut while hidden in the
// sidebar (or vice versa). When a user lacks the required permission, the
// shortcut no-ops silently.
// ---------------------------------------------------------------------------

const LEAVES = navLeaves();

const SHORTCUT_PERMISSION_GATE: Record<string, Permission> = Object.fromEntries(
  LEAVES.filter((l) => l.permission).map((l) => [l.shortcutKey, l.permission!])
);

export function useKeyboardShortcuts() {
  const {
    setView,
    openTaskModal,
    openProjectModal,
    setShortcutsOpen,
    setNotifOpen,
    sidebarRail,
    toggleSidebarRail,
  } = useApp();
  const { can } = usePermissions();
  // PR-65 — ⌘B toggles the rail, a per-user preference; persist it.
  const persistAppearance = usePersistAppearance();

  useEffect(() => {
    let lastG = 0;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.tagName === "SELECT";

      // Cmd+K handled by command palette itself. Cmd+B toggles the sidebar
      // rail (PR-58) — like ⌘K it works even while typing in an input.
      // PR-65 — the rail is per-user; persist the new state.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // The next rail state is persisted per-user (PR-65).
        persistAppearance({ sidebarRail: !sidebarRail });
        toggleSidebarRail();
        return;
      }

      // "?" opens shortcuts — works even when typing? no, only when not typing
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (typing) return;

      // True while a G-prefix keystroke is pending — the single-key
      // bindings below must NOT fire in that window, or they shadow the
      // documented G-bindings: "p" was eating G P (projects view opened
      // the project modal instead) and "b" was eating G B (bugs view
      // opened the notification panel). "n" was eating G N (My Payslips
      // opened the task modal) and "i" was eating G I (Hiring opened the
      // inbox) — the n/i variants were caught in the persona-audit P0-1
      // review.
      const gPending = lastG !== 0 && Date.now() - lastG < 800;

      // Single-key shortcuts
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !gPending) {
        e.preventDefault();
        openTaskModal();
        return;
      }
      if (e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey && !gPending) {
        e.preventDefault();
        openProjectModal();
        return;
      }
      if (e.key.toLowerCase() === "b" && !e.metaKey && !e.ctrlKey && !gPending) {
        e.preventDefault();
        setNotifOpen(true);
        return;
      }
      if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey && !gPending) {
        e.preventDefault();
        useApp.getState().setInboxOpen(true);
        return;
      }

      // G then key — view switching
      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey) {
        lastG = Date.now();
        return;
      }
      if (lastG && Date.now() - lastG < 800) {
        // PR-58 — the letter → view map derives from the nav config, same
        // as the sidebar. setView auto-expands the target's sidebar group.
        const map: Record<string, () => void> = Object.fromEntries(
          LEAVES.map((l) => [l.shortcutKey, () => setView(l.key)])
        );
        const shortcutKey = e.key.toLowerCase();
        const action = map[shortcutKey];
        if (action) {
          // L-P0-15: gate admin/audit views by the same permissions the
          // sidebar uses. If the user lacks the permission, no-op silently
          // (do not navigate, do not fire the action, do not toast an error).
          const requiredPermission = SHORTCUT_PERMISSION_GATE[shortcutKey];
          if (requiredPermission && !can(requiredPermission)) {
            e.preventDefault();
            lastG = 0;
            return;
          }
          e.preventDefault();
          action();
          lastG = 0;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setView, openTaskModal, openProjectModal, setShortcutsOpen, setNotifOpen, toggleSidebarRail, can, persistAppearance, sidebarRail]);
}
