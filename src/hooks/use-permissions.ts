"use client";

import { hasPermission, type Permission, type Role } from "@/lib/rbac";
import { useAppSession } from "@/hooks/use-app-session";

/**
 * Client-side hook for checking permissions.
 * Uses the NextAuth session to get the current user's role.
 */
export function usePermissions() {
  const { data: session } = useAppSession();
  const role = (session?.user?.role as Role) || "MEMBER";

  return {
    role,
    can: (permission: Permission) => hasPermission(role, permission),
  };
}
