// Server-side authorization helpers.
// NOTE: This file intentionally does NOT have "use server" because it exports
// non-function values (the AuthorizationError class). It's imported by server
// actions and server components, which is fine — it runs on the server only.

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasPermission, isValidRole, type Permission, type Role } from "@/lib/rbac";

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

export class AuthorizationError extends Error {
  /** Stable marker preserved across the server→client boundary so clients can
   * recognise authorisation failures even when production masks messages. */
  readonly digest = "AuthorizationError";

  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
