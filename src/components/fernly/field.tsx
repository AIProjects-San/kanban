"use client";

import { cn } from "@/lib/utils";

/**
 * Form field wrapper — label + input/children.
 *
 * Used by every modal form in the app (task, project, user, member, event,
 * settings). Replaces 6+ identical inline copies.
 */
export function Field({
  label,
  children,
  className,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  /** Optional small hint text shown below the input. */
  hint?: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-foreground mb-1.5">{label}</label>
      {children}
      {hint && <div className="mt-1">{hint}</div>}
    </div>
  );
}

/**
 * Two-column grid for form fields — matches the `grid grid-cols-2 gap-3`
 * pattern repeated in every modal.
 */
export function FormRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}
