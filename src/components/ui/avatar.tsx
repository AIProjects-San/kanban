"use client";

import { cn } from "@/lib/utils";

// PR-40 — the size set is closed on purpose: every size renders as a static
// `.f-av-<size>` class (globals.css) instead of an inline style attribute,
// so the production CSP can ship `style-src 'self'` without 'unsafe-inline'.
// Adding a size = add the class trio in globals.css, then extend this union.
export const AVATAR_SIZES = [18, 20, 24, 28, 32, 36, 40, 48, 64] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

interface AvatarProps {
  name: string;
  color?: string;
  size?: AvatarSize;
  className?: string;
  online?: boolean;
}

export function Avatar({ name, color = "forest", size = 32, className, online }: AvatarProps) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={cn("relative inline-flex", `f-av-${size}`, className)}>
      <span className={cn("f-avatar", `f-avatar-${color}`)}>{initials}</span>
      {online !== undefined && (
        <span
          className={cn(
            "f-av-dot absolute bottom-0 right-0 rounded-full border-2 border-white",
            online ? "bg-emerald-500" : "bg-zinc-400",
          )}
        />
      )}
    </span>
  );
}
