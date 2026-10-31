"use client";

import { Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type Role } from "@/lib/rbac";

const ROLE_STYLES: Record<Role, string> = {
  ADMIN: "bg-destructive/10 text-destructive",
  MANAGER: "bg-primary/10 text-primary",
  MEMBER: "bg-muted text-muted-foreground",
};

/**
 * Badge that displays a user role (Admin / Manager / Member) with the
 * standard color scheme. Replaces 2+ copies across rbac-view, users-view,
 * and login-screen's inline roleColors.
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
