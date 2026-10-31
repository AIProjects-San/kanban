"use client";

import { useState } from "react";
import {
  Search,
  Bell,
  Menu,
  Moon,
  Sun,
  Check,
  ChevronDown,
  CircleDot,
  Inbox,
  LogOut,
} from "lucide-react";
import { useApp } from "@/store/app-store";
import { ROLE_LABELS, type Role } from "@/lib/rbac";
import { Avatar } from "./avatar";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { appSignOut } from "@/lib/signout";
import type { NotificationT, MessageT } from "@/lib/types";

interface TopbarProps {
  notifs: NotificationT[];
  messages: MessageT[];
  user: { id: string; name: string; email: string; avatarColor: string; role: string };
  onMarkAllRead: () => void;
}

export function Topbar({ notifs, messages, user, onMarkAllRead }: TopbarProps) {
  const { setSidebarOpen, setCmdkOpen, setNotifOpen, notifOpen, dark, setDark, setInboxOpen } = useApp();
  const [profileOpen, setProfileOpen] = useState(false);
  const unread = notifs.filter((n) => !n.read).length;
  const unreadMessages = messages.filter((m) => m.direction === "IN" && !m.read).length;

  return (
    <header className="sticky top-0 z-20 h-16 bg-background/80 backdrop-blur border-b border-border flex items-center gap-3 px-4 lg:px-6">
      <button
        className="f-btn f-btn-ghost f-btn-icon lg:hidden"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open sidebar"
      >
        <Menu size={18} />
      </button>

      {/* Search */}
      <button
        onClick={() => setCmdkOpen(true)}
        className="hidden md:flex items-center gap-2 h-9 px-3 w-72 bg-muted/60 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
      >
        <Search size={15} />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-background border border-border">
          ⌘K
        </kbd>
      </button>

      <button
        onClick={() => setCmdkOpen(true)}
        className="md:hidden f-btn f-btn-ghost f-btn-icon"
        aria-label="Search"
      >
        <Search size={18} />
      </button>

      <div className="flex-1" />

      {/* Inbox / Messages */}
      <button
        onClick={() => setInboxOpen(true)}
        className="f-btn f-btn-ghost f-btn-icon relative"
        aria-label="Inbox"
        title="Inbox"
      >
        <Inbox size={18} />
        {unreadMessages > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[0.625rem] font-bold">
            {unreadMessages}
          </span>
        )}
      </button>

      {/* Theme toggle */}
      <button
        onClick={async () => {
          const newVal = !dark;
          setDark(newVal);
          // Persist to DB (best-effort, non-blocking)
          if (user?.id) {
            try {
              const { updateUserSettings } = await import("@/server-actions/data");
              await updateUserSettings(user.id, { dark: newVal });
            } catch { /* ignore — non-critical */ }
          }
        }}
        className="f-btn f-btn-ghost f-btn-icon"
        aria-label="Toggle theme"
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* Notifications */}
      <div className="relative">
        <button
          onClick={() => setNotifOpen(!notifOpen)}
          className="f-btn f-btn-ghost f-btn-icon relative"
          aria-label="Notifications"
        >
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
          )}
        </button>
        {notifOpen && (
          <NotificationsDropdown
            notifs={notifs}
            onClose={() => setNotifOpen(false)}
            onMarkAllRead={onMarkAllRead}
          />
        )}
      </div>

      {/* Profile */}
      <div className="relative">
        <button
          onClick={() => setProfileOpen(!profileOpen)}
          className="flex items-center gap-2 h-9 pl-1 pr-2 rounded-lg hover:bg-muted transition-colors"
          aria-label="Account menu"
          aria-expanded={profileOpen}
        >
          <Avatar name={user.name} color={user.avatarColor} size={28} />
          <div className="hidden lg:flex flex-col items-start leading-tight">
            <span className="text-xs font-semibold text-foreground">{user.name}</span>
            <span className="text-[0.625rem] text-muted-foreground">{user.role}</span>
          </div>
          <ChevronDown size={14} className={cn("text-muted-foreground transition-transform", profileOpen && "rotate-180")} />
        </button>
        {profileOpen && (
          <ProfileMenu user={user} onClose={() => setProfileOpen(false)} />
        )}
      </div>
    </header>
  );
}

function ProfileMenu({
  user,
  onClose,
}: {
  user: { name: string; email: string; avatarColor: string; role: string };
  onClose: () => void;
}) {
  const roleLabel = ROLE_LABELS[user.role as Role] ?? user.role;
  const handleSignOut = () => {
    void appSignOut();
  };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className="absolute right-0 top-11 w-60 bg-card border border-border rounded-lg shadow-xl p-1.5 z-50 f-view-enter">
        {/* Identity */}
        <div className="px-3 py-2.5 border-b border-border mb-1">
          <div className="flex items-center gap-2.5">
            <Avatar name={user.name} color={user.avatarColor} size={36} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">{user.name}</div>
              <div className="text-xs text-muted-foreground truncate">{user.email}</div>
            </div>
          </div>
          <span className="inline-block mt-2 f-badge bg-primary/10 text-primary">{roleLabel}</span>
        </div>

        <button
          onClick={() => {
            useApp.getState().setView("settings");
            onClose();
          }}
          className="w-full text-left px-3 py-2 rounded-md hover:bg-muted text-sm text-foreground"
        >
          Settings
        </button>
        <button
          onClick={() => {
            useApp.getState().setView("help");
            onClose();
          }}
          className="w-full text-left px-3 py-2 rounded-md hover:bg-muted text-sm text-foreground"
        >
          Help & Shortcuts
        </button>

        <div className="border-t border-border my-1" />
        <button
          onClick={handleSignOut}
          className="w-full text-left px-3 py-2 rounded-md hover:bg-destructive/10 text-sm text-destructive flex items-center gap-2"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </>
  );
}

function NotificationsDropdown({
  notifs,
  onClose,
  onMarkAllRead,
}: {
  notifs: NotificationT[];
  onClose: () => void;
  onMarkAllRead: () => void;
}) {
  const typeIcon = (t: string) => {
    switch (t) {
      case "TASK": return <CircleDot size={14} className="text-primary" />;
      case "WARNING": return <Bell size={14} className="text-warning" />;
      case "SUCCESS": return <Check size={14} className="text-success" />;
      case "MENTION": return <CircleDot size={14} className="text-purple-500" />;
      default: return <CircleDot size={14} className="text-muted-foreground" />;
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-11 w-80 sm:w-96 bg-card border border-border rounded-lg shadow-xl z-40 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Notifications</span>
            {notifs.filter((n) => !n.read).length > 0 && (
              <span className="text-[0.625rem] font-bold px-1.5 py-0.5 rounded-full bg-destructive text-white">
                {notifs.filter((n) => !n.read).length}
              </span>
            )}
          </div>
          <button
            onClick={onMarkAllRead}
            className="text-xs text-primary hover:underline"
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto f-scroll">
          {notifs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            notifs.map((n) => (
              <div
                key={n.id}
                className={cn(
                  "px-4 py-3 border-b border-border last:border-0 hover:bg-muted/60 transition-colors cursor-pointer",
                  !n.read && "bg-primary/5"
                )}
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5">{typeIcon(n.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-foreground">{n.title}</span>
                      {n.recipientUserId === null && (
                        <span
                          title="Workspace-wide — visible to everyone"
                          className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[0.5625rem] font-medium uppercase tracking-wide bg-muted text-muted-foreground border border-border"
                        >
                          All
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</div>
                    <div className="text-[0.625rem] text-muted-foreground/70 mt-1">
                      {timeAgo(n.createdAt)}
                    </div>
                  </div>
                  {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5" />}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
