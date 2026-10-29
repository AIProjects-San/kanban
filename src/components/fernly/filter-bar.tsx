"use client";

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FilterOption {
  key: string;
  label: string;
  /** Optional count shown in parentheses. */
  count?: number;
}

/**
 * Reusable filter bar — a row of pill buttons with an optional search input.
 *
 * Replaces 6+ hand-rolled copies across tasks-view, projects-view, users-view,
 * team-view, audit-view, and analytics-view. Standardizes the padding,
 * selected style, and search-input placement.
 *
 * Usage:
 *   <FilterBar
 *     filters={[{ key: "all", label: "All", count: 24 }, { key: "running", label: "Running", count: 12 }]}
 *     value={filter}
 *     onChange={setFilter}
 *     search={{ value: query, onChange: setQuery, placeholder: "Search…" }}
 *   />
 */
export function FilterBar({
  filters,
  value,
  onChange,
  search,
  className,
}: {
  filters: FilterOption[];
  value: string;
  onChange: (v: string) => void;
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      {search && (
        <div className="relative">
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? "Search…"}
            className="f-input h-9 w-56 pl-8 text-sm"
          />
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        </div>
      )}
      <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => onChange(f.key)}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              value === f.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {f.label}
            {f.count !== undefined && (
              <span className="text-muted-foreground/70 ml-1">({f.count})</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
