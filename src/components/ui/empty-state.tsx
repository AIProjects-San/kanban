"use client";

import { cn } from "@/lib/shared/utils";

/**
 * Empty state placeholder — used everywhere a list / grid / timeline can be
 * empty. Pass an `icon` for visual emphasis, plus `title` and optional
 * `description`. Optionally an `action` button.
 *
 * Replaces 8+ inline `text-center py-N text-sm text-muted-foreground` blocks
 * across tasks-view, users-view, rbac-view, team-view, etc.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-center py-10 text-sm text-muted-foreground", className)}>
      {icon && (
        <div className="flex justify-center mb-3 text-muted-foreground/60">
          {icon}
        </div>
      )}
      <div className="font-medium text-foreground text-sm">{title}</div>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
