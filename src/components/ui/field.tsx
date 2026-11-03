"use client";

import { useId, isValidElement, cloneElement, type ReactElement } from "react";

/**
 * Form field wrapper — label + input/children.
 *
 * Used by every modal form in the app (task, project, user, member, event,
 * settings). Replaces 6+ identical inline copies.
 *
 * PR-41 (a11y): the label is now PROGRAMMATICALLY associated with the
 * control — `useId` + `htmlFor` + the id injected into the single child
 * element. A bare <label> next to an input gives screen readers nothing,
 * and axe flagged the settings inputs (`label` / `select-name`, critical).
 * This fixes every Field-wrapped input, select and textarea app-wide.
 * Children that are not a single element (fragments, lists, components
 * that ignore id) degrade gracefully to the old unassociated label.
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
  const id = useId();
  const child =
    isValidElement(children) && !(children as ReactElement<{ id?: string }>).props.id
      ? cloneElement(children as ReactElement<{ id?: string }>, { id })
      : children;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-foreground mb-1.5">{label}</label>
      {child}
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
