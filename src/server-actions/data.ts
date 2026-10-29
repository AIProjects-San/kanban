// ---------------------------------------------------------------------------
// Barrel re-export — keeps every existing `@/server-actions/data` import
// working while the implementation lives in per-domain modules.
//
// NOTE: this file deliberately does NOT have "use server". The domain modules
// below carry the directive, so their exports are already compiled as server
// references; re-exporting them here just gives callers one stable import
// path. (A "use server" barrel cannot re-export — Turbopack strips re-exports
// from action modules.)
//
// Domain modules (each with "use server"):
//   dashboard.ts     — getDashboardData, getMyProjects, getProjectMembers
//   tasks.ts         — task CRUD + move
//   projects.ts      — project CRUD
//   members.ts       — team-member CRUD
//   events.ts        — calendar events
//   notifications.ts — notification read-state (per-user + broadcasts)
//   reminders.ts     — personal reminders
//   users.ts         — accounts, profiles, settings, passwords, directory
//   time-entries.ts  — time tracking
//   messages.ts      — team messaging
//   assignments.ts   — user↔project staffing
//   workspace.ts     — workspace settings, config tables, role management
//   audit.ts         — audit log readers
//
// Server-only helpers (NO "use server"): shared.ts, result.ts, auth-guard.ts
// — import those directly; they are not remote procedures.
// ---------------------------------------------------------------------------

export type { WorkspaceConfig } from "@/lib/config-loader";

export {
  getDashboardData,
  getMyProjects,
  getProjectMembers,
} from "./dashboard";
export { createTask, updateTask, moveTask, deleteTask } from "./tasks";
export { createProject, updateProject, deleteProject } from "./projects";
export { createMember, updateMember, deleteMember } from "./members";
export { createEvent, deleteEvent } from "./events";
export { markNotificationRead, markAllNotificationsRead } from "./notifications";
export { toggleReminder, createReminder } from "./reminders";
export {
  getUserProfile,
  getUserSettings,
  updateUserSettings,
  updateProfile,
  changePassword,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserByEmail,
} from "./users";
export { logTime } from "./time-entries";
export {
  sendMessage,
  markMessageRead,
  markThreadRead,
  deleteMessage,
} from "./messages";
export {
  assignUserToProject,
  unassignUserFromProject,
  getUserProjectAssignments,
  getProjectAssignments,
} from "./assignments";
export {
  loadWorkspaceConfig,
  updateWorkspaceSettings,
  updateConfigItem,
  createConfigItem,
  deleteConfigItem,
  updateRole,
  createRole,
  deleteRole,
} from "./workspace";
export { getAuditLogs, getAuditLogsForEntity } from "./audit";
