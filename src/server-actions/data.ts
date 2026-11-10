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
// PR-54 — JWT bearer-token issuance for external/programmatic clients.
export { issueAuthToken, type IssuedToken } from "./auth-tokens";
// PR-63 — role-scoped analytics (self / team / individual / everyone),
// enforced server-side; see analytics.ts for the authorization matrix.
export {
  getAnalyticsData,
  type AnalyticsData,
  type AnalyticsFilterOptions,
  type AnalyticsScope,
} from "./analytics";
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
  // PR-64 — live RBAC refresh: effective permissions for the signed-in
  // user (polled by AppShell so role-permission saves reflect immediately).
  getMyPermissions,
} from "./users";
// Board enhancement — task-level time log (required vs spent) + Task ↔ Bug
// link reads used by the task modal.
export { logTime, logTaskTime, getTaskTimeLog, deleteTimeEntry } from "./time-entries";
export { getTaskLinkedBugs, getLinkableBugs } from "./bugs";
export {
  sendMessage,
  markMessageRead,
  markThreadRead,
  deleteMessage,
} from "./messages";
// L-P0-9 — paginated list actions with server-side search.
export {
  getUsersPage,
  getTasksPage,
  getProjectsPage,
  getTimeEntriesPage,
  type PaginatedResult,
  type UserListItem,
  type TaskListItem,
  type ProjectListItem,
  type TimeEntryListItem,
} from "./pagination";
// L-P0-11 — self-service password reset.
export {
  requestPasswordReset,
  validateResetToken,
  resetPassword,
} from "./password-reset";
// L-P1-20 — audit log retention.
export {
  pruneAuditLogs,
  getAuditRetentionInfo,
} from "./audit-retention";
export type { PruneResult } from "@/lib/audit-retention-config";
// L-P2-30 — global data search.
export {
  searchWorkspace,
  type SearchResults,
  type SearchHit,
} from "./search";
// L-P2-33 — trash / restore. PR-38 adds the right-to-erasure hard erase.
export {
  getTrash,
  restoreProject,
  restoreUser,
  restoreMessage,
  eraseUser,
  type TrashItem,
} from "./trash";
// L-P2-35 — GDPR data export.
export {
  exportMyData,
  type UserDataExport,
} from "./data-export";
// L-P2-31 — bulk task operations.
export {
  bulkUpdateTasks,
  type BulkTaskPatch,
  type BulkUpdateResult,
} from "./bulk";
// L-P2-38 — ICS calendar export.
export {
  exportCalendarIcs,
  type IcsExport,
} from "./ics-export";
export {
  assignUserToProject,
  unassignUserFromProject,
  getUserProjectAssignments,
  getProjectAssignments,
  getProjectAssignableUsers,
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
// P24 (PL-01) — the notification template master (Settings → Notifications).
export {
  updateNotificationTemplate,
  resetNotificationTemplate,
} from "./notification-templates";
// P27 (LV-08) — the leave period master (HR console → Types & Policies).
export {
  listLeavePeriods,
  createLeavePeriod,
  deleteLeavePeriod,
  type LeavePeriodT,
} from "./leave-periods";
// P28 (LV-02/LV-03) — the leave policy set master + the bulk assignment
// tool (HR console → Types & Policies).
export {
  listLeavePolicyState,
  createLeavePolicySet,
  updateLeavePolicySet,
  deleteLeavePolicySet,
  bulkAssignLeavePolicySet,
  deleteLeavePolicyAssignment,
  type BulkAssignLeavePolicySetResult,
  type LeavePolicyStateT,
  type PolicySetEmployeeT,
} from "./leave-policy-sets";
export { getAuditLogs, getAuditLogsForEntity } from "./audit";
