"use client";

import { hasPermission, type Permission, type Role } from "@/lib/rbac";
import { useAppSession } from "@/hooks/use-app-session";
import { useApp } from "@/store/app-store";

/**
 * Client-side hook for checking permissions.
 *
 * PR-64 — permission checks now use the SERVER-computed effective set
 * (static floor ∪ DB ceiling) whenever it is loaded. The static matrix is
 * only a fallback (pre-hydration, unit tests): it cannot see DB-granted
 * permissions, so an admin's role-permission save would otherwise never
 * reflect for already-logged-in users. AppShell seeds the set from the SSR
 * payload and keeps it fresh via the getMyPermissions poll.
 */
export function usePermissions() {
  const { data: session } = useAppSession();
  const role = (session?.user?.role as Role) || "MEMBER";
  const effectivePermissions = useApp((s) => s.effectivePermissions);

  return {
    role,
    can: (permission: Permission) =>
      effectivePermissions !== null
        ? effectivePermissions.includes(permission)
        : hasPermission(role, permission),
  };
}
