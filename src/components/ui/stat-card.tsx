"use client";

import { cn } from "@/lib/shared/utils";

/**
 * Stat card — icon + value + label, with optional delta badge and two layout
 * variants. Replaces StatBlock (team-view), MetricCard (analytics-view),
 * StatCard (audit-view), Stat (login-screen), and the inline KPI in
 * dashboard-view.
 *
 * `layout`:
 *   - "vertical" (default) — icon on top, value below, label at bottom.
 *     Used in team-view and dashboard KPIs.
 *   - "horizontal" — icon left, value + label right. Used in audit-view.
 */
export function StatCard({
  icon: Icon,
  value,
  label,
  iconColor,
  iconBg,
  delta,
  deltaType = "neutral",
  layout = "vertical",
  className,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  value: React.ReactNode;
  label: string;
  iconColor: string;
  iconBg: string;
  /** Optional delta badge (e.g. "+12%"). */
  delta?: string;
  /** Controls the delta badge color. */
  deltaType?: "up" | "down" | "neutral";
  layout?: "vertical" | "horizontal";
  className?: string;
}) {
  if (layout === "horizontal") {
    return (
      <div className={cn("f-card p-4 flex items-center gap-3", className)}>
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
          <Icon size={18} className={iconColor} />
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-foreground tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("f-card f-card-hover p-5", className)}>
      <div className="flex items-center justify-between mb-3">
        <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", iconBg)}>
          <Icon size={20} className={iconColor} />
        </div>
        {delta && (
          <span
            className={cn(
              "text-[0.625rem] font-bold px-1.5 py-0.5 rounded-full",
              deltaType === "up" && "bg-success/10 text-success",
              deltaType === "down" && "bg-destructive/10 text-destructive",
              deltaType === "neutral" && "bg-muted text-muted-foreground"
            )}
          >
            {delta}
          </span>
        )}
      </div>
      <div className="text-3xl font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
