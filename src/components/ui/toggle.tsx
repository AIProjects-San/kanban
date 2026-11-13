"use client";

import { cn } from "@/lib/shared/utils";

/**
 * Toggle switch — accessible on/off control.
 *
 * Replaces the hand-rolled `Toggle` in settings-view. Used for notification
 * preferences, dark mode, and any other boolean setting.
 *
 * PR-41 (a11y): `role="switch"` needs an accessible name — axe `button-name`
 * flagged every nameless instance. Call sites MUST pass `label` (enforced
 * by the axe gate in the e2e suite).
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch (visually hidden — the visible setting
   *  title is rendered separately in settings rows). */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        disabled && "opacity-50 cursor-not-allowed"
      )}
      role="switch"
      aria-checked={checked}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}
