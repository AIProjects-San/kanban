"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  LayoutDashboard,
  CheckSquare,
  Calendar,
  BarChart3,
  Users,
  Settings,
  HelpCircle,
  History,
  Shield,
  Plus,
  Moon,
  Sun,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useApp, type ViewKey } from "@/store/app-store";
import { hasPermission, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { ACCENTS } from "@/lib/constants";

interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number }>;
  action: () => void;
  group: "Navigation" | "Create" | "Theme";
}

export function CommandPalette() {
  const {
    cmdkOpen, setCmdkOpen,
    setView, openTaskModal, openProjectModal, openMemberModal,
    dark, setDark, setAccent,
  } = useApp();
  const [query, setQuery] = useState("");
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen(!cmdkOpen);
      }
      if (e.key === "Escape" && cmdkOpen) setCmdkOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cmdkOpen, setCmdkOpen]);

  useEffect(() => {
    if (!cmdkOpen) setQuery("");
  }, [cmdkOpen]);

  const items: CmdItem[] = useMemo(() => {
    type NavEntry = { key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }> };
    const nav: NavEntry[] = [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { key: "tasks", label: "Tasks", icon: CheckSquare },
      { key: "calendar", label: "Calendar", icon: Calendar },
      { key: "analytics", label: "Analytics", icon: BarChart3 },
      { key: "team", label: "Team", icon: Users },
      { key: "settings", label: "Settings", icon: Settings },
      { key: "rbac", label: "Roles & Permissions", icon: Shield },
      ...(hasPermission(role, "audit:view")
        ? [{ key: "audit" as ViewKey, label: "Audit Log", icon: History } satisfies NavEntry]
        : []),
      { key: "help", label: "Help & Shortcuts", icon: HelpCircle },
    ];
    return [
      ...nav.map((n) => ({
        id: `nav-${n.key}`,
        label: `Go to ${n.label}`,
        icon: n.icon,
        action: () => { setView(n.key); setCmdkOpen(false); },
        group: "Navigation" as const,
      })),
      {
        id: "new-task",
        label: "Create new task",
        hint: "N",
        icon: Plus,
        action: () => { openTaskModal(); setCmdkOpen(false); },
        group: "Create",
      },
      {
        id: "new-project",
        label: "Create new project",
        icon: Plus,
        action: () => { openProjectModal(); setCmdkOpen(false); },
        group: "Create",
      },
      {
        id: "new-member",
        label: "Invite team member",
        icon: Plus,
        action: () => { openMemberModal(); setCmdkOpen(false); },
        group: "Create",
      },
      {
        id: "toggle-theme",
        label: dark ? "Switch to light mode" : "Switch to dark mode",
        icon: dark ? Sun : Moon,
        action: () => { setDark(!dark); setCmdkOpen(false); },
        group: "Theme",
      },
      ...ACCENTS.map((a) => {
        const Icon = a.icon;
        return {
          id: `accent-${a.key}`,
          label: `Theme: ${a.label}`,
          icon: Icon,
          action: () => { setAccent(a.key); setCmdkOpen(false); },
          group: "Theme" as const,
        };
      }),
    ];
  }, [setView, setCmdkOpen, openTaskModal, openProjectModal, openMemberModal, dark, setDark, setAccent]);

  const filtered = items.filter((i) =>
    i.label.toLowerCase().includes(query.toLowerCase())
  );
  const grouped = filtered.reduce<Record<string, CmdItem[]>>((acc, i) => {
    (acc[i.group] ||= []).push(i);
    return acc;
  }, {});

  if (!cmdkOpen || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      onClick={() => setCmdkOpen(false)}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden />
      <div
        className="relative w-full max-w-xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-14 border-b border-border">
          <Search size={18} className="text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
          <kbd className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto f-scroll p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No results for “{query}”
            </div>
          ) : (
            Object.entries(grouped).map(([group, list]) => (
              <div key={group} className="mb-2">
                <div className="px-3 py-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </div>
                {list.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={item.action}
                      className="w-full flex items-center gap-3 px-3 h-9 rounded-md hover:bg-muted text-sm text-foreground text-left transition-colors"
                    >
                      <Icon size={16} />
                      <span className="flex-1">{item.label}</span>
                      {item.hint && (
                        <kbd className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                          {item.hint}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
