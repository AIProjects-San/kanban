"use client";

import { cn } from "@/lib/utils";

interface AvatarProps {
  name: string;
  color?: string;
  size?: number;
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
    <span className={cn("relative inline-flex", className)} style={{ width: size, height: size }}>
      <span
        className={cn("f-avatar", `f-avatar-${color}`)}
        style={{ width: size, height: size, fontSize: size * 0.36 }}
      >
        {initials}
      </span>
      {online !== undefined && (
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full border-2 border-white",
            online ? "bg-emerald-500" : "bg-zinc-400"
          )}
          style={{ width: size * 0.28, height: size * 0.28 }}
        />
      )}
    </span>
  );
}
