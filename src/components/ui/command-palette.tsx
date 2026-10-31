"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  LayoutDashboard,
  CheckSquare,
  FolderKanban,
  Calendar,
  BarChart3,
  Users,
  Settings,
  HelpCircle,
  History,
  Plus,
  UserPlus,
  Moon,
  Sun,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useApp, type ViewKey } from "@/store/app-store";
import { hasPermission, type Role } from "@/lib/rbac";
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
    setView, openTaskModal, openProjectModal, openUserModal,
    dark, setDark, setAccent,
  } = useApp();
  const [query, setQuery] = useState("");
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;
  const canManageRoles = hasPermission(role, "role:manage");
  const canViewAudit = hasPermission(role, "audit:view");

  // Every close path (Escape, ⌘K toggle, item action, backdrop click) goes
  // through this helper so the search box always resets — no effect needed
  // (the upgraded react-hooks plugin correctly flags setState-in-effect).
  const closeCmdk = useCallback(() => {
    setCmdkOpen(false);
    setQuery("");
  }, [setCmdkOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (cmdkOpen) {
          closeCmdk();
        } else {
          setCmdkOpen(true);
        }
      }
      if (e.key === "Escape" && cmdkOpen) closeCmdk();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cmdkOpen, setCmdkOpen, closeCmdk]);

  const items: CmdItem[] = useMemo(() => {
    type NavEntry = { key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }> };
    // Navigation mirrors the sidebar exactly (src/components/ui/sidebar.tsx)
    // so ⌘K and the sidebar expose the same set of reachable views. Role-gated
    // entries are conditionally included to match the sidebar's filter logic.
    const nav: NavEntry[] = [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { key: "tasks", label: "Tasks", icon: CheckSquare },
      { key: "projects", label: "Projects", icon: FolderKanban },
      { key: "calendar", label: "Calendar", icon: Calendar },
      { key: "analytics", label: "Analytics", icon: BarChart3 },
      { key: "team", label: "Team", icon: Users },
      { key: "settings", label: "Settings", icon: Settings },
      ...(canManageRoles
        ? [{ key: "users" as ViewKey, label: "Users", icon: UserPlus } satisfies NavEntry]
        : []),
      ...(canManageRoles
        ? [{ key: "workspace-settings" as ViewKey, label: "Workspace Config", icon: Settings } satisfies NavEntry]
        : []),
      ...(canViewAudit
        ? [{ key: "audit" as ViewKey, label: "Audit Log", icon: History } satisfies NavEntry]
        : []),
      { key: "help", label: "Help & Shortcuts", icon: HelpCircle },
    ];
    return [
      ...nav.map((n) => ({
        id: `nav-${n.key}`,
        label: `Go to ${n.label}`,
        icon: n.icon,
        action: () => { setView(n.key); closeCmdk(); },
        group: "Navigation" as const,
      })),
      {
        id: "new-task",
        label: "Create new task",
        hint: "N",
        icon: Plus,
        action: () => { openTaskModal(); closeCmdk(); },
        group: "Create",
      },
      {
        id: "new-project",
        label: "Create new project",
        hint: "P",
        icon: Plus,
        action: () => { openProjectModal(); closeCmdk(); },
        group: "Create",
      },
      // The "Invite team member" entry used to live here and opened the
      // MemberModal, which still exposes an obsolete "Create new" tab that
      // creates a TeamMember without a login account. That workflow is
      // superseded by UserModal ("Create user" below) which mints a real
      // login + team-member row in one shot. The MemberModal is now only
      // reachable from the Team page's "Add Member" button (which only
      // offers the "pick an existing user" path).
      ...(canManageRoles
        ? [{
            id: "new-user",
            label: "Create user",
            icon: UserPlus,
            action: () => { openUserModal(); closeCmdk(); },
            group: "Create" as const,
          }]
        : []),
      {
        id: "toggle-theme",
        label: dark ? "Switch to light mode" : "Switch to dark mode",
        icon: dark ? Sun : Moon,
        action: () => { setDark(!dark); closeCmdk(); },
        group: "Theme",
      },
      ...ACCENTS.map((a) => {
        const Icon = a.icon;
        return {
          id: `accent-${a.key}`,
          label: `Theme: ${a.label}`,
          icon: Icon,
          action: () => { setAccent(a.key); closeCmdk(); },
          group: "Theme" as const,
        };
      }),
    ];
  }, [setView, closeCmdk, openTaskModal, openProjectModal, openUserModal, dark, setDark, setAccent, canManageRoles, canViewAudit]);

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
      onClick={() => closeCmdk()}
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
