"use client";

import { useState, useEffect, useMemo } from "react";
import {
  History, RefreshCw, Loader2, ShieldAlert, Search,
  ChevronDown, Activity, CalendarDays, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type Role  } from "@/lib/auth/rbac";
import { getAuditLogs } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/action-result";
import { Avatar } from "../ui/avatar";
import { StatCard } from "../ui/stat-card";
import { FilterBar } from "../ui/filter-bar";
import { timeAgo } from "@/lib/time";
import { getActionMeta, getEntityBadge, AUDIT_FILTERS } from "@/lib/audit/audit-meta";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/use-permissions";

interface AuditEntryT {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  detail: string;
  createdAt: string;
}

interface AuditViewProps {
  currentUser: { id: string; name: string; email: string; role: string };
}

export function AuditView({ currentUser }: AuditViewProps) {
  const { can } = usePermissions();
  const role = currentUser.role as Role;
  const canView = can("audit:view");

  const [logs, setLogs] = useState<AuditEntryT[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (canView) loadLogs();
  }, [canView]);

  async function loadLogs() {
    setLoading(true);
    try {
      const result = await getAuditLogs();
      if (result.ok) {
        setLogs(result.data);
      } else {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to load audit log"));
    } finally {
      setLoading(false);
    }
  }

  const actors = useMemo(
    () => Array.from(new Set(logs.map((l) => l.actorName))).sort(),
    [logs]
  );

  const filtered = useMemo(() => {
    const types = AUDIT_FILTERS.find((f) => f.key === filter)?.types ?? null;
    return logs.filter((l) => {
      if (types && !types.includes(l.entityType)) return false;
      if (actorFilter !== "all" && l.actorName !== actorFilter) return false;
      if (query) {
        const hay = `${l.detail} ${l.entityLabel} ${l.actorName} ${l.action}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
  }, [logs, filter, actorFilter, query]);

  // Group into day buckets
  const dayGroups = useMemo(() => {
    const groups: { label: string; entries: AuditEntryT[] }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let currentLabel = "";
    for (const log of filtered) {
      const d = new Date(log.createdAt);
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      let label: string;
      if (day.getTime() === today.getTime()) label = "Today";
      else if (day.getTime() === yesterday.getTime()) label = "Yesterday";
      else label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long" });
      if (label !== currentLabel) {
        groups.push({ label, entries: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].entries.push(log);
    }
    return groups;
  }, [filtered]);

  // Stats
  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return {
      total: logs.length,
      today: logs.filter((l) => new Date(l.createdAt).getTime() >= today.getTime()).length,
      week: logs.filter((l) => new Date(l.createdAt).getTime() >= weekAgo.getTime()).length,
      actors: actors.length,
    };
  }, [logs, actors]);

  if (!canView) {
    return (
      <div className="space-y-5 max-w-4xl">
        <AuditHeader />
        <div className="f-card p-6 border-dashed">
          <div className="flex items-center gap-3 text-muted-foreground">
            <ShieldAlert size={20} />
            <div>
              <div className="text-sm font-medium text-foreground">Audit log restricted</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your role ({ROLE_LABELS[role]}) does not have permission to view the audit log.
                Only Admins and Managers can see the full history of workspace changes.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <AuditHeader
        right={
          <button
            onClick={loadLogs}
            className="f-btn f-btn-secondary f-btn-sm"
            title="Refresh audit log"
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            Refresh
          </button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={History} label="Recorded actions" value={stats.total} iconColor="text-primary" iconBg="bg-primary/10" layout="horizontal" />
        <StatCard icon={Activity} label="Today" value={stats.today} iconColor="text-primary" iconBg="bg-primary/10" layout="horizontal" />
        <StatCard icon={CalendarDays} label="Last 7 days" value={stats.week} iconColor="text-primary" iconBg="bg-primary/10" layout="horizontal" />
        <StatCard icon={Users} label="People involved" value={stats.actors} iconColor="text-primary" iconBg="bg-primary/10" layout="horizontal" />
      </div>

      {/* Filters */}
      <div className="f-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search activity…"
              className="f-input h-8 w-48 text-xs pl-7"
            />
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
          <div className="relative">
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="f-input h-8 w-40 text-xs appearance-none pr-7"
              title="Filter by person"
            >
              <option value="all">Everyone</option>
              {actors.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          </div>
          <FilterBar
            filters={AUDIT_FILTERS}
            value={filter}
            onChange={setFilter}
          />
        </div>
      </div>

      {/* Timeline */}
      {loading ? (
        <div className="f-card py-12 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading audit trail…
        </div>
      ) : dayGroups.length === 0 ? (
        <div className="f-card py-12 text-center">
          <History size={28} className="mx-auto text-muted-foreground/40" />
          <div className="text-sm font-medium text-foreground mt-3">No activity found</div>
          <p className="text-xs text-muted-foreground mt-1">
            Actions like creating tasks, editing projects, or changing roles will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {dayGroups.map((group) => (
            <div key={group.label}>
              <div className="flex items-center gap-2 mb-2 px-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </span>
                {/* PR-41 — /60 alpha on muted-foreground fails AA (≈2.6:1); the
                    full token clears 4.5:1 (PR-39 measured 6.5:1). */}
                <span className="text-[0.625rem] text-muted-foreground">
                  {group.entries.length} {group.entries.length === 1 ? "action" : "actions"}
                </span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="f-card overflow-hidden">
                {group.entries.map((log, idx) => (
                  <AuditRow key={log.id} log={log} last={idx === group.entries.length - 1} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer note */}
      <p className="text-[0.6875rem] text-muted-foreground px-1">
        Showing the {logs.length} most recent recorded actions. Read receipts (opening messages,
        marking notifications read) are intentionally not audited.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AuditHeader({ right }: { right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <History size={22} className="text-primary" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Audit Log</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every change in this workspace, recorded automatically — who did what, and when.
        </p>
      </div>
      {right}
    </div>
  );
}

function AuditRow({ log, last }: { log: AuditEntryT; last: boolean }) {
  const meta = getActionMeta(log.action);
  const Icon = meta.icon;
  const badge = getEntityBadge(log.entityType);

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors",
        !last && "border-b border-border"
      )}
    >
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", meta.cls)}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Avatar name={log.actorName} color={avatarColorForRole(log.actorRole)} size={18} />
          <span className="text-xs font-semibold text-foreground">{log.actorName}</span>
          {log.actorRole && (
            <span className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground font-medium">
              {ROLE_LABELS[log.actorRole as Role] ?? log.actorRole}
            </span>
          )}
        </div>
        <p className="text-sm text-foreground mt-0.5">{log.detail}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <time
          className="text-[0.625rem] text-muted-foreground whitespace-nowrap"
          title={new Date(log.createdAt).toLocaleString()}
        >
          {timeAgo(log.createdAt)}
        </time>
        {badge && (
          <span className={cn("f-badge text-[0.5625rem] px-1.5 py-0", badge.cls)}>{badge.label}</span>
        )}
      </div>
    </div>
  );
}

function avatarColorForRole(role: string): string {
  switch (role) {
    case "ADMIN": return "forest";
    case "MANAGER": return "ocean";
    case "MEMBER": return "plum";
    default: return "slate";
  }
}
