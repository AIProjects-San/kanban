"use client";

import { useEffect } from "react";
import { useApp } from "@/store/app-store";

export function useKeyboardShortcuts() {
  const {
    setView,
    openTaskModal,
    openProjectModal,
    setShortcutsOpen,
    setNotifOpen,
  } = useApp();

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

      // Single-key shortcuts
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openTaskModal();
        return;
      }
      if (e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openProjectModal();
        return;
      }
      if (e.key.toLowerCase() === "b" && !e.metaKey && !e.ctrlKey) {
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
        };
        const action = map[e.key.toLowerCase()];
        if (action) {
          e.preventDefault();
          action();
          lastG = 0;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setView, openTaskModal, openProjectModal, setShortcutsOpen, setNotifOpen]);
}
