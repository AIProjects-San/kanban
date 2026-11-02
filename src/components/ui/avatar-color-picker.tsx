"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENTS, PROJECT_COLORS } from "@/lib/constants";
import type { AccentTheme } from "@/store/app-store";

/**
 * Color picker for avatar / accent themes.
 *
 * Replaces 4 inline copies (user-modal, settings-view, member-modal uses
 * project colors, project-modal uses project colors). Pass `variant` to
 * control the selected indicator:
 *   - "ring"  → border-foreground ring (user-modal style)
 *   - "check" → white check overlay (settings-view style)
 *
 * For project-only colors (which include "slate"), use `ProjectColorPicker`.
 */
export function AvatarColorPicker({
  value,
  onChange,
  variant = "ring",
}: {
  value: AccentTheme;
  onChange: (c: AccentTheme) => void;
  variant?: "ring" | "check";
}) {
  return (
    <div className="flex gap-2">
      {ACCENTS.map((a) => (
        <button
          key={a.key}
          onClick={() => onChange(a.key)}
          className={cn(
            "w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all",
            value === a.key
              ? variant === "ring"
                ? "border-foreground scale-110"
                : "border-foreground"
              : "border-transparent"
          )}
          style={{ background: a.color }}
          aria-label={a.label}
        >
          {variant === "check" && value === a.key && <Check size={14} className="text-white" />}
        </button>
      ))}
    </div>
  );
}

/**
 * Color picker for project colors (includes "slate" which isn't an avatar theme).
 * Uses the `f-avatar f-avatar-${color}` class system instead of inline styles.
 */
export function ProjectColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  const colors = PROJECT_COLORS;
  return (
    <div className="flex gap-2">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={cn(
            "w-8 h-8 rounded-full f-avatar f-avatar-" + c,
            value === c
              ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
              : ""
          )}
          aria-label={c}
        />
      ))}
    </div>
  );
}
