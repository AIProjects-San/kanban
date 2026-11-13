"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/shared/utils";

/**
 * Card section with an icon + title + description header.
 *
 * Replaces the non-collapsible `Section` in settings-view and the
 * `CollapsibleSection` in rbac-view, plus several inline copies of the same
 * "icon block + title + subtitle" pattern.
 *
 * Pass `collapsible` to make the section expandable/collapsible (chevron
 * rotates, children animate in). When not collapsible, children are always
 * visible.
 */
export function Section({
  icon: Icon,
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = true,
  className,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <div className={cn("f-card p-6", className)}>
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon size={18} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
          </div>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className={cn("f-card overflow-hidden", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 p-5 text-left hover:bg-muted/40 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon size={16} className="text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
          </div>
        </div>
        <ChevronDown
          size={18}
          className={cn("text-muted-foreground transition-transform shrink-0", open && "rotate-180")}
        />
      </button>
      {open && <div className="px-5 pb-5 f-view-enter">{children}</div>}
    </div>
  );
}
