// Fernly RBAC — Role-Based Access Control
// Defines roles, permissions, and helper functions for authorization.

export type Role = "ADMIN" | "MANAGER" | "MEMBER";

export type Permission =
  | "task:create"
  | "task:edit:any"
  | "task:edit:own"
  | "task:delete"
  | "project:create"
  | "project:edit"
  | "project:delete"
  | "member:invite"
  | "member:edit"
  | "member:delete"
  | "message:send"
  | "event:create"
  | "event:delete"
  | "settings:edit"
  | "role:manage"
  | "analytics:view"
  | "team:view"
  | "audit:view";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    "task:create", "task:edit:any", "task:edit:own", "task:delete",
    "project:create", "project:edit", "project:delete",
    "member:invite", "member:edit", "member:delete",
    "message:send", "event:create", "event:delete",
    "settings:edit", "role:manage", "analytics:view", "team:view",
    "audit:view",
  ],
  MANAGER: [
    "task:create", "task:edit:any", "task:edit:own",
    "project:create", "project:edit",
    "member:invite",
    "message:send", "event:create", "event:delete",
    "settings:edit", "analytics:view", "team:view",
    "audit:view",
  ],
  MEMBER: [
    "task:create", "task:edit:own",
    "message:send",
    "settings:edit", "analytics:view", "team:view",
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  MEMBER: "Member",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "Full access — can delete anything, manage roles, and configure the workspace",
  MANAGER: "Can create projects, invite members, and edit tasks. Cannot delete or manage roles.",
  MEMBER: "Can create/edit own tasks, send messages, and view analytics. Cannot create projects or invite members.",
};

export const ALL_PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: "task:create", label: "Create tasks", description: "Add new tasks to the Kanban board" },
  { key: "task:edit:own", label: "Edit own tasks", description: "Modify tasks assigned to you" },
  { key: "task:edit:any", label: "Edit any task", description: "Modify tasks assigned to anyone" },
  { key: "task:delete", label: "Delete tasks", description: "Remove tasks from the board" },
  { key: "project:create", label: "Create projects", description: "Add new projects to the workspace" },
  { key: "project:edit", label: "Edit projects", description: "Modify project details and status" },
  { key: "project:delete", label: "Delete projects", description: "Remove projects permanently" },
  { key: "member:invite", label: "Invite members", description: "Add new team members" },
  { key: "member:edit", label: "Edit members", description: "Modify team member details" },
  { key: "member:delete", label: "Remove members", description: "Remove team members from the workspace" },
  { key: "message:send", label: "Send messages", description: "Send messages to team members" },
  { key: "event:create", label: "Create events", description: "Add events to the calendar" },
  { key: "event:delete", label: "Delete events", description: "Remove calendar events" },
  { key: "settings:edit", label: "Edit settings", description: "Modify own profile and preferences" },
  { key: "role:manage", label: "Manage roles", description: "Change other users' roles" },
  { key: "analytics:view", label: "View analytics", description: "Access the analytics dashboard" },
  { key: "team:view", label: "View team", description: "See the team member directory" },
  { key: "audit:view", label: "View audit log", description: "See the full history of who changed what in the workspace" },
];

export function hasPermission(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Numeric rank for the three system roles, used by the user-hierarchy
 * helpers in `lib/hierarchy.ts` to answer "does A outrank B?" without
 * consulting the DB. Higher = more powerful.
 *
 *   ADMIN = 3, MANAGER = 2, MEMBER = 1, unknown/missing = 0.
 *
 * Note: hierarchy-aware RBAC uses BOTH `roleRank` (positional authority)
 * AND the manager-chain (`canManageUser` in `lib/hierarchy.ts`) — a
 * MANAGER can edit a peer MEMBER only if that MEMBER is in their subtree.
 * Role rank alone is NOT enough to authorise a hierarchy-scoped action.
 */
export function roleRank(role: Role | string | undefined | null): number {
  switch (role) {
    case "ADMIN": return 3;
    case "MANAGER": return 2;
    case "MEMBER": return 1;
    default: return 0;
  }
}

/**
 * True iff `actorRole` strictly outranks `targetRole` (>= is NOT enough;
 * same-rank users cannot manage each other via role alone — they need a
 * manager-chain relationship).
 */
export function outranks(actorRole: Role | string | undefined | null, targetRole: Role | string | undefined | null): boolean {
  return roleRank(actorRole) > roleRank(targetRole);
}

export function isValidRole(role: string): role is Role {
  return role === "ADMIN" || role === "MANAGER" || role === "MEMBER";
}
