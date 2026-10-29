"use client";
import { useState, useEffect } from "react";
import { ChevronDown, History, Loader2, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAuditLogsForEntity } from "@/server-actions/data";
import { timeAgo } from "@/lib/time";

interface AuditLogEntry {
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

interface EntityHistorySectionProps {
  /** The Prisma entityType — must match what's written to AuditLog.entityType.
   *  e.g. "TASK", "PROJECT", "MEMBER", "USER", "EVENT", "REMINDER", "MESSAGE", "TIME" */
  entityType: string;
  /** The record id to look up audit entries for. */
  entityId: string;
  /** Human-readable label for the entity (shown in the empty-state message). */
  entityLabel?: string;
  /** Override the section title. Defaults to "History & Audit". */
  title?: string;
}

/**
 * Reusable expandable audit-history timeline.
 *
 * Drop this into any edit modal / drawer to show a collapsible list of every
 * recorded change to that entity. The section is collapsed by default and
 * lazy-loads its data on first expand (one round trip to
 * `getAuditLogsForEntity`).
 *
 * Usage:
 *   {editing && (
 *     <EntityHistorySection
 *       entityType="PROJECT"
 *       entityId={editing.id}
 *       entityLabel={editing.name}
 *     />
 *   )}
 */
export function EntityHistorySection({
  entityType,
  entityId,
  entityLabel,
  title = "History & Audit",
}: EntityHistorySectionProps) {
  const [open, setOpen] = useState(false);
  // null = not loaded yet (panel hasn't been opened); [] = loaded, empty; non-empty = loaded
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on first expand only — avoids an extra round trip when the user just
  // opens the modal to make a quick edit. We guard against re-fetching once we
  // already have data (logs !== null).
  useEffect(() => {
    if (!open || logs !== null) return;
    let cancelled = false;
    // Defer the loading flag toggle to a microtask so it doesn't run
    // synchronously inside the effect body (which lint flags as cascading renders).
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });
    getAuditLogsForEntity(entityType, entityId)
      .then((result) => {
        if (!cancelled) setLogs(result as AuditLogEntry[]);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load history");
          setLogs([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entityId, entityType, logs]);

  const emptyMessage = entityLabel
    ? `No activity has been recorded for “${entityLabel}” yet.`
    : "No activity has been recorded yet.";

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <History size={12} className="text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">{title}</div>
            <div className="text-[0.625rem] text-muted-foreground truncate">
              {logs === null
                ? "Tap to load the change timeline"
                : logs.length === 0
                  ? "No recorded activity yet"
                  : `${logs.length} recorded ${logs.length === 1 ? "event" : "events"}`}
            </div>
          </div>
        </div>
        <ChevronDown
          size={14}
          className={cn("text-muted-foreground transition-transform shrink-0", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 f-view-enter">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading history…
            </div>
          ) : error ? (
            <div className="text-xs text-destructive py-4 text-center">{error}</div>
          ) : logs && logs.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">{emptyMessage}</div>
          ) : logs ? (
            <ol className="relative space-y-3 pl-4 before:content-[''] before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-border">
              {logs.map((log) => (
                <li key={log.id} className="relative">
                  <span className="absolute -left-4 top-1 w-2.5 h-2.5 rounded-full border-2 border-card bg-primary" />
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-medium text-foreground">{log.actorName}</span>
                    {log.actorRole && (
                      <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                        {log.actorRole}
                      </span>
                    )}
                    <span className="text-[0.625rem] text-muted-foreground ml-auto">
                      {timeAgo(log.createdAt)}
                    </span>
                  </div>
                  <div className="text-xs text-foreground mt-0.5 leading-snug">{log.detail}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <CircleDot size={9} className="text-muted-foreground/60" />
                    <span className="text-[0.625rem] text-muted-foreground/70 font-mono">{log.action}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
    </div>
  );
}
