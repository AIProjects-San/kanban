"use client";

import { useEffect } from "react";
import { useApp } from "@/store/app-store";
import { usePermissions } from "@/hooks/use-permissions";
import type { Permission } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// L-P0-15 — Permission map for G-prefix view shortcuts.
//
// Mirrors the sidebar's gating exactly: u (Users) requires role:manage,
// w (Workspace Config) requires role:manage, l (Audit Log) requires
// audit:view. Shortcuts not in the gate map are unrestricted. When a user
// lacks the required permission, the shortcut no-ops silently.
// ---------------------------------------------------------------------------

const SHORTCUT_PERMISSION_GATE: Record<string, Permission> = {
  u: "role:manage",  // G U → users view — admin only
  w: "role:manage",  // G W → workspace-settings — admin only
  l: "audit:view",   // G L → audit log — admin + manager
  r: "hr:view",      // G R → HR console — admin + manager + HR
};

export function useKeyboardShortcuts() {
  const {
    setView,
    openTaskModal,
    openProjectModal,
    setShortcutsOpen,
    setNotifOpen,
  } = useApp();
  const { can } = usePermissions();

  useEffect(() => {
    let lastG = 0;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.tagName === "SELECT";

      // Cmd+K handled by command palette itself
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return;

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
      // opened the notification panel instead).
      const gPending = lastG !== 0 && Date.now() - lastG < 800;

      // Single-key shortcuts
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
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
      if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey) {
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
        const map: Record<string, () => void> = {
          d: () => setView("dashboard"),
          t: () => setView("tasks"),
          p: () => setView("projects"),
          c: () => setView("calendar"),
          a: () => setView("analytics"),
          m: () => setView("team"),
          s: () => setView("settings"),
          u: () => setView("users"),
          w: () => setView("workspace-settings"),
          h: () => setView("help"),
          l: () => setView("audit"),
          b: () => setView("bugs"),
          v: () => setView("leave"),
          r: () => setView("hr"),
        };
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
  }, [setView, openTaskModal, openProjectModal, setShortcutsOpen, setNotifOpen, can]);
}
