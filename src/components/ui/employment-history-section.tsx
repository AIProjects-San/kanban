"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ArrowUpRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEmploymentHistory } from "@/server-actions/employment";
import { EMPLOYMENT_PROPERTY_LABELS, EMPLOYMENT_CHANGE_KIND_LABELS } from "@/lib/hr/employment-change";
import type { EmploymentPropertyHistoryT } from "@/lib/types";

// ---------------------------------------------------------------------------
// P33 (EM-06) — the structured employment-changes panel (the benchmark's
// Employee Property History child rendered under the Employee form).
//
// Collapsed by default, lazy-loads on first expand (one round trip to
// getEmploymentHistory — the same pattern EntityHistorySection owns for
// the free-form audit log; THIS panel is the structured per-property
// diff: property, current → new, the effective date and the change kind).
// ---------------------------------------------------------------------------

export function EmploymentChangesSection({
  userId,
  userName,
}: {
  userId: string;
  userName: string;
}) {
  const [open, setOpen] = useState(false);
  // null = not loaded yet (panel unexpanded); [] = loaded, empty.
  const [rows, setRows] = useState<EmploymentPropertyHistoryT[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || rows !== null) return;
    let cancelled = false;
    // Defer the loading flag to a microtask so it doesn't run synchronously
    // inside the effect body (the EntityHistorySection convention).
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });
    getEmploymentHistory(userId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setRows(res.data);
        else {
          setError(res.error);
          setRows([]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load employment changes");
          setRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId, rows]);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-muted/30" data-testid="employment-changes">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center shrink-0">
            <ArrowUpRight size={12} className="text-emerald-600" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">Employment changes</div>
            <div className="text-[0.625rem] text-muted-foreground truncate">
              {rows === null
                ? "Promotions and transfers, property by property"
                : rows.length === 0
                  ? "No structured changes recorded yet"
                  : `${rows.length} recorded property change${rows.length === 1 ? "" : "s"}`}
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
              <Loader2 size={12} className="animate-spin" /> Loading changes…
            </div>
          ) : error ? (
            <div className="text-xs text-destructive py-4 text-center">{error}</div>
          ) : rows && rows.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">
              {`No promotions or transfers have been recorded for “${userName}” yet — the structured history starts at the first applied change.`}
            </div>
          ) : rows ? (
            <ol className="relative space-y-3 pl-4 before:content-[''] before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-border">
              {rows.map((r) => (
                <li key={r.id} className="relative" data-testid="employment-change-row">
                  <span className="absolute -left-4 top-1 w-2.5 h-2.5 rounded-full border-2 border-card bg-emerald-500" />
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-medium text-foreground">
                      {EMPLOYMENT_PROPERTY_LABELS[r.property as keyof typeof EMPLOYMENT_PROPERTY_LABELS] ?? r.property}
                    </span>
                    <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {EMPLOYMENT_CHANGE_KIND_LABELS[r.sourceKind as keyof typeof EMPLOYMENT_CHANGE_KIND_LABELS] ?? r.sourceKind}
                    </span>
                    <span className="text-[0.625rem] text-muted-foreground ml-auto">
                      effective {r.effectiveAt}
                    </span>
                  </div>
                  <div className="text-xs text-foreground mt-0.5 leading-snug">
                    {r.currentValue || "—"} <span className="text-muted-foreground">→</span> {r.newValue || "—"}
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
