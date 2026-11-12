// Fernly RBAC — Role-Based Access Control
// Defines roles, permissions, and helper functions for authorization.

export type Role = "SUPER_ADMIN" | "ADMIN" | "MANAGER" | "MEMBER" | "HR";

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
  | "audit:view"
  // Bug tracking — QA raises bugs; developers work them.
  | "bug:create"
  | "bug:edit:any"
  | "bug:edit:own"
  | "bug:delete"
  | "bug:assign"
  // HR module (docs/HR_MODULE_PLAN.md) — leave, directory, reviews,
  // onboarding. hr:view gates the HR console nav; hr:admin gates
  // workspace-level config (leave types & policies). leave:request is the
  // self-service baseline every role holds.
  | "hr:view"
  | "hr:admin"
  | "leave:request"
  | "review:manage"
  | "onboarding:manage"
  // F1.3 — attendance records (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.1): HR/admin marking of daily attendance. A NEW permission,
  // deliberately NOT hr:admin — the two target the same ADMIN+HR audience
  // today, but a DB permission ceiling (settings:edit → role permissions)
  // can diverge them without attendance ever granting leave-type config or
  // vice versa. Members never write attendance (decision §9.1) — they read
  // their own month via the self-scoped getMyAttendance.
  | "attendance:manage"
  // Recruitment module (docs/RECRUITMENT_MODULE_PLAN.md §3) — HR-driven:
  // HR + ADMIN drive the pipeline; MANAGERs see the board because they are
  // interviewers (R2 assigns them stages), but cannot create/advance.
  | "hiring:view"
  | "hiring:manage"
  | "hiring:config"
  // F2.10 (R11/D-20) — offer approval: the four-eyes step between HR
  // composing a draft and it being sendable. Deliberately granted to
  // MANAGER but NOT HR — the approver must be a different pair of eyes
  // than the composer (approveOffer additionally refuses the composer
  // themself, so an ADMIN who composed cannot self-approve). HR keeps
  // hiring:manage and can still send — but only an APPROVED offer.
  | "hiring:approve"
  // Payroll (RECRUITMENT_MODULE_PLAN.md §5 R7) — salary data is sensitive:
  // ADMIN + HR only. MANAGERs (interviewers on the hiring board) and
  // MEMBERs never see structures, runs or payslips.
  | "payroll:manage"
  // NZ statutory payroll engine (Phase 0) — the statutory rate tables
  // (StatutoryRateSet + children) and their seed/refresh operations.
  // Deliberately SUPER_ADMIN ONLY: statutory master data drives every
  // payslip's tax lines, so it sits above the ADMIN+HR payroll:manage
  // ceiling — a plain ADMIN can run payroll but never rewrite the tax
  // tables it computes from.
  | "statutory:manage";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // NZ statutory engine (Phase 0) — SUPER_ADMIN: the workspace owner's
  // owner. Holds EVERY permission including statutory:manage (the only
  // role that does). Seeded, never granted through the plain role-assignment
  // UI: promoting a user TO SUPER_ADMIN requires an existing SUPER_ADMIN
  // (users.ts guard, mirroring the F-14 ADMIN rule one level up).
  SUPER_ADMIN: [
    "task:create", "task:edit:any", "task:edit:own", "task:delete",
    "project:create", "project:edit", "project:delete",
    "member:invite", "member:edit", "member:delete",
    "message:send", "event:create", "event:delete",
    "settings:edit", "role:manage", "analytics:view", "team:view",
    "audit:view",
    "bug:create", "bug:edit:any", "bug:edit:own", "bug:delete", "bug:assign",
    "hr:view", "hr:admin", "leave:request", "review:manage", "onboarding:manage",
    "hiring:view", "hiring:manage", "hiring:config", "hiring:approve",
    "payroll:manage",
    "attendance:manage",
    "statutory:manage",
  ],
  ADMIN: [
    "task:create", "task:edit:any", "task:edit:own", "task:delete",
    "project:create", "project:edit", "project:delete",
    "member:invite", "member:edit", "member:delete",
    "message:send", "event:create", "event:delete",
    "settings:edit", "role:manage", "analytics:view", "team:view",
    "audit:view",
    "bug:create", "bug:edit:any", "bug:edit:own", "bug:delete", "bug:assign",
    "hr:view", "hr:admin", "leave:request", "review:manage", "onboarding:manage",
    "hiring:view", "hiring:manage", "hiring:config", "hiring:approve",
    "payroll:manage",
    "attendance:manage",
  ],
  MANAGER: [
    "task:create", "task:edit:any", "task:edit:own",
    "project:create", "project:edit",
    "member:invite",
    "message:send", "event:create", "event:delete",
    "settings:edit", "analytics:view", "team:view",
    "audit:view",
    "bug:create", "bug:edit:any", "bug:edit:own", "bug:assign",
    "hr:view", "leave:request", "review:manage",
    "hiring:view",
    // F2.10 — managers are the offer approvers (distinct from the HR
    // composer; four-eyes on every sent offer).
    "hiring:approve",
  ],
  MEMBER: [
    "task:create", "task:edit:own",
    "message:send",
    "settings:edit", "analytics:view", "team:view",
    "bug:create", "bug:edit:own",
    "leave:request",
  ],
  // HR — the people-operations role (docs/HR_MODULE_PLAN.md). Rank 2 (same
  // as MANAGER): outranks() is strict, so HR and MANAGER cannot manage each
  // other by rank alone. HR holds the MEMBER self-service baseline plus the
  // hr:* family — deliberately NO task/project powers.
  HR: [
    "message:send",
    "settings:edit", "analytics:view", "team:view",
    "leave:request",
    "hr:view", "hr:admin", "review:manage", "onboarding:manage",
    "hiring:view", "hiring:manage", "hiring:config",
    "payroll:manage",
    "attendance:manage",
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  MANAGER: "Manager",
  MEMBER: "Member",
  HR: "HR",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  SUPER_ADMIN: "Workspace super admin — everything an admin can do, plus the NZ statutory rate tables (the only role that can edit them)",
  ADMIN: "Full access — can delete anything, manage roles, and configure the workspace",
  MANAGER: "Can create projects, invite members, and edit tasks. Cannot delete or manage roles.",
  MEMBER: "Can create/edit own tasks, send messages, and view analytics. Cannot create projects or invite members.",
  HR: "People operations — manages leave types/policies, reviews and onboarding, and sees the leave console. No project or task powers.",
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
  { key: "bug:create", label: "Raise bugs", description: "Report a new bug" },
  { key: "bug:edit:own", label: "Edit own bugs", description: "Edit bugs you reported or are assigned to" },
  { key: "bug:edit:any", label: "Edit any bug", description: "Edit any bug regardless of reporter/assignee" },
  { key: "bug:delete", label: "Delete bugs", description: "Permanently remove a bug report" },
  { key: "bug:assign", label: "Assign bugs", description: "Assign a bug to a developer" },
  { key: "hr:view", label: "View HR console", description: "See the leave queue, directory, reviews and onboarding dashboards" },
  { key: "hr:admin", label: "Configure HR", description: "Manage leave types, policies and onboarding templates" },
  { key: "leave:request", label: "Request leave", description: "Submit time-off requests and see own balances" },
  { key: "review:manage", label: "Manage reviews", description: "Create performance review cycles for direct reports" },
  { key: "onboarding:manage", label: "Manage onboarding", description: "Create and assign onboarding checklists" },
  { key: "hiring:view", label: "View hiring pipeline", description: "See the candidate board and stage timelines (interviewers included)" },
  { key: "hiring:manage", label: "Manage hiring", description: "Create candidates, advance stages and decide outcomes in the recruitment pipeline" },
  { key: "hiring:config", label: "Configure hiring", description: "Edit the workspace hiring stage template and document types" },
  { key: "hiring:approve", label: "Approve offers", description: "Approve draft offers before they are sent (managers — the approver must differ from the HR composer)" },
  { key: "payroll:manage", label: "Manage payroll", description: "Maintain salary structures, run monthly payroll, edit and lock payslips" },
  { key: "attendance:manage", label: "Manage attendance", description: "Mark and edit daily attendance for everyone in the workspace" },
  { key: "statutory:manage", label: "Manage statutory rates", description: "Edit the NZ statutory rate tables (PAYE slabs, ACC levy, KiwiSaver, ESCT, student loan) — super admin only" },
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
 *   SUPER_ADMIN = 4, ADMIN = 3, MANAGER = 2, MEMBER = 1, unknown/missing = 0.
 *
 * Note: hierarchy-aware RBAC uses BOTH `roleRank` (positional authority)
 * AND the manager-chain (`canManageUser` in `lib/hierarchy.ts`) — a
 * MANAGER can edit a peer MEMBER only if that MEMBER is in their subtree.
 * Role rank alone is NOT enough to authorise a hierarchy-scoped action.
 */
export function roleRank(role: Role | string | undefined | null): number {
  switch (role) {
    case "SUPER_ADMIN": return 4; // NZ statutory engine (Phase 0) — above ADMIN: outranks every role
    case "ADMIN": return 3;
    case "MANAGER": return 2;
    case "HR": return 2; // same rank as MANAGER — outranks() stays strict, so neither manages the other by rank
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
  return role === "SUPER_ADMIN" || role === "ADMIN" || role === "MANAGER" || role === "MEMBER" || role === "HR";
}
