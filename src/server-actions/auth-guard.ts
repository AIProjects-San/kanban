// Server-side authorization helpers.
// NOTE: This file intentionally does NOT have "use server" because it exports
// non-function values (the AuthorizationError class). It's imported by server
// actions and server components, which is fine — it runs on the server only.

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasPermission, isValidRole, type Permission, type Role } from "@/lib/rbac";
import { canManageUser, getSubtreeUserIds } from "@/lib/hierarchy";
import { db } from "@/lib/db";

interface AuthResult {
  userId: string;
  role: Role;
  name: string;
  email: string;
}

/**
 * Get the current authenticated session.
 * Returns null if not logged in.
 */
export async function getSession(): Promise<AuthResult | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  const role = isValidRole(session.user.role) ? session.user.role : "MEMBER";
  return {
    userId: session.user.id,
    role,
    name: session.user.name,
    email: session.user.email,
  };
}

/**
 * Require that the current user has a specific permission.
 * Throws an AuthorizationError if not.
 */
export async function requirePermission(permission: Permission): Promise<AuthResult> {
  const auth = await getSession();
  if (!auth) {
    throw new AuthorizationError("You must be signed in to perform this action.");
  }
  if (!hasPermission(auth.role, permission)) {
    throw new AuthorizationError(
      `Your role (${auth.role}) does not have permission to ${permission.replace(":", " ")}.`
    );
  }
  return auth;
}

/**
 * Require any authenticated session. Throws an AuthorizationError if the
 * caller is not signed in. Use this for actions that don't need a specific
 * permission but must never run unauthenticated.
 */
export async function getSessionOrThrow(): Promise<AuthResult> {
  const auth = await getSession();
  if (!auth) {
    throw new AuthorizationError("You must be signed in.");
  }
  return auth;
}

/**
 * Hierarchy-aware permission gate. Performs the standard role-based
 * permission check (`requirePermission`) AND a hierarchy check: the
 * signed-in user must be allowed to manage `targetUserId` per the
 * reporting tree (see `lib/hierarchy.ts` → `canManageUser`).
 *
 * Use this for any action that mutates or reads another user's data:
 * updateUser, deleteUser, getUserProfile (for non-self), assignManager,
 * role changes, etc. Self-targeted calls (where targetUserId ===
 * auth.userId) are always allowed at the hierarchy layer — caller-side
 * self-protection rules (e.g. "cannot demote yourself") still apply.
 *
 * Returns the resolved AuthResult for the caller to use in audit logs.
 */
export async function requirePermissionForTarget(
  permission: Permission,
  targetUserId: string,
): Promise<AuthResult> {
  const auth = await requirePermission(permission);
  if (auth.userId === targetUserId) {
    // Self-management: hierarchy check passes. Caller enforces any extra
    // self-protection rules (e.g. "cannot change own role").
    return auth;
  }
  // Fetch the target's identity + managerId so we can apply canManageUser.
  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, managerId: true },
  });
  if (!target) {
    throw new AuthorizationError("User not found.");
  }
  const targetRole = isValidRole(target.role) ? target.role : "MEMBER";
  // Compute the actor's subtree once. For admins this is short-circuited
  // inside canManageUser before the subtree is consulted.
  const actorSubtree = auth.role === "ADMIN" ? new Set<string>() : await getSubtreeUserIds(auth.userId);
  if (!canManageUser(
    { userId: auth.userId, role: auth.role },
    { userId: target.id, role: targetRole, managerId: target.managerId },
    actorSubtree,
  )) {
    throw new AuthorizationError(
      "You can only manage users in your reporting chain. " +
      "This user is not one of your direct or transitive reports.",
    );
  }
  return auth;
}

export class AuthorizationError extends Error {
  /** Stable marker preserved across the server→client boundary so clients can
   * recognise authorisation failures even when production masks messages. */
  readonly digest = "AuthorizationError";

  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
