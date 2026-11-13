"use client";

import { Shield } from "lucide-react";
import { cn } from "@/lib/shared/utils";
import { ROLE_LABELS, type Role } from "@/lib/auth/rbac";

const ROLE_STYLES: Record<Role, string> = {
  SUPER_ADMIN: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  ADMIN: "bg-destructive/10 text-destructive",
  MANAGER: "bg-primary/10 text-primary",
  MEMBER: "bg-muted text-muted-foreground",
  HR: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
};

/**
 * Badge that displays a user role (Super Admin / Admin / Manager / Member)
 * with the standard color scheme. Replaces 2+ copies across rbac-view,
 * users-view, and login-screen's inline roleColors.
 */
export function RoleBadge({
  role,
  icon = false,
  className,
}: {
  role: Role;
  /** Show a small shield icon before the label. */
  icon?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("f-badge", ROLE_STYLES[role], className)}>
      {icon && <Shield size={9} className="mr-0.5" />}
      {ROLE_LABELS[role]}
    </span>
  );
}
