"use client";

import {
  LayoutDashboard,
  CheckSquare,
  FolderKanban,
  Calendar,
  BarChart3,
  Users,
  Settings,
  HelpCircle,
  History,
  LogOut,
  X,
  Leaf,
  UserCog,
  Settings2,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useApp, type ViewKey } from "@/store/app-store";
import { hasPermission, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";

interface NavItem {
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  shortcut: string;
}

const mainNav: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "G D" },
  { key: "tasks", label: "Tasks", icon: CheckSquare, shortcut: "G T" },
  { key: "projects", label: "Projects", icon: FolderKanban, shortcut: "G P" },
  { key: "calendar", label: "Calendar", icon: Calendar, shortcut: "G C" },
  { key: "analytics", label: "Analytics", icon: BarChart3, shortcut: "G A" },
  { key: "team", label: "Team", icon: Users, shortcut: "G M" },
];

const generalNav: NavItem[] = [
  { key: "settings", label: "Settings", icon: Settings, shortcut: "G S" },
  { key: "users", label: "Users", icon: UserCog, shortcut: "G U" },
  { key: "workspace-settings", label: "Workspace Config", icon: Settings2, shortcut: "G W" },
  { key: "audit", label: "Audit Log", icon: History, shortcut: "G L" },
  { key: "help", label: "Help", icon: HelpCircle, shortcut: "G H" },
];

export function Sidebar() {
  const { view, setView, sidebarOpen, setSidebarOpen } = useApp();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;
  // Audit Log is only visible to roles with audit:view (Admin, Manager).
  // Users management is only visible to roles with role:manage (Admin only).
  // Workspace Config is only visible to roles with role:manage (Admin only).
  const visibleGeneralNav = generalNav.filter((item) => {
    if (item.key === "audit") return hasPermission(role, "audit:view");
    if (item.key === "users") return hasPermission(role, "role:manage");
    if (item.key === "workspace-settings") return hasPermission(role, "role:manage");
    return true;
  });

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed lg:sticky top-0 left-0 z-40 h-screen w-64 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-200",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Brand */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
              <Leaf size={18} />
            </div>
            <span className="text-base font-semibold text-sidebar-foreground tracking-tight">
              Fernly
            </span>
          </div>
          <button
            className="f-btn f-btn-ghost f-btn-icon lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto f-scroll px-3 py-4">
          <div className="px-2 mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Workspace
          </div>
          <div className="space-y-1">
            {mainNav.map((item) => (
              <NavButton key={item.key} item={item} active={view === item.key} onClick={() => setView(item.key)} />
            ))}
          </div>

          <div className="px-2 mt-6 mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            General
          </div>
          <div className="space-y-1">
            {visibleGeneralNav.map((item) => (
              <NavButton key={item.key} item={item} active={view === item.key} onClick={() => setView(item.key)} />
            ))}
          </div>
        </nav>

        {/* Logout */}
        <div className="p-3 border-t border-sidebar-border">
          <button
            onClick={() => signOut({ callbackUrl: "/", redirect: false }).then(() => window.location.replace(window.location.pathname))}
            className="f-nav-item w-full"
          >
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      data-active={active}
      className="f-nav-item w-full"
    >
      <Icon size={18} />
      <span className="flex-1 text-left">{item.label}</span>
      <kbd className="hidden lg:inline text-[0.625rem] text-muted-foreground/70 font-mono">
        {item.shortcut}
      </kbd>
    </button>
  );
}
