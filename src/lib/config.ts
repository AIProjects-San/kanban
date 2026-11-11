/**
 * Centralized domain configuration — single source of truth for all status
 * enums, style maps, and label tables used across the app.
 *
 * Every view and modal imports from here instead of redefining its own local
 * copy. This guarantees visual consistency (one color per status) and makes
 * adding a new status a one-line change.
 */

import type {
  TaskStatus,
  ProjectStatus,
  Priority,
  TaskTag,
  Department,
  EventType,
  BugSeverity,
  BugPriority,
  BugStatus,
  BugResolution,
  LeaveStatus,
  ReviewStatus,
  AttendanceStatus,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Task statuses — used by task-modal (select), tasks-view (Kanban columns),
// team-view (status dots), and server-actions (audit detail strings).
// ---------------------------------------------------------------------------

export interface TaskStatusDef {
  key: TaskStatus;
  label: string;
  /** Tailwind bg class for the status dot / accent. */
  accent: string;
}

export const TASK_STATUSES: TaskStatusDef[] = [
  { key: "TODO", label: "To do", accent: "bg-zinc-400" },
  { key: "IN_PROGRESS", label: "In progress", accent: "bg-blue-500" },
  { key: "IN_REVIEW", label: "In review", accent: "bg-amber-500" },
  { key: "DONE", label: "Done", accent: "bg-emerald-500" },
];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = Object.fromEntries(
  TASK_STATUSES.map((s) => [s.key, s.label]),
) as Record<TaskStatus, string>;

export const TASK_STATUS_ACCENT: Record<TaskStatus, string> = Object.fromEntries(
  TASK_STATUSES.map((s) => [s.key, s.accent]),
) as Record<TaskStatus, string>;

// ---------------------------------------------------------------------------
// Project statuses — used by project-modal (select) and projects-view (badges).
// ---------------------------------------------------------------------------

export interface ProjectStatusDef {
  key: ProjectStatus;
  label: string;
  /** Tailwind classes for the badge background + text. */
  badge: string;
  /** Tailwind bg class for the status dot. */
  dot: string;
}

export const PROJECT_STATUSES: ProjectStatusDef[] = [
  { key: "RUNNING", label: "Running", badge: "bg-primary/10 text-primary", dot: "bg-primary" },
  { key: "PENDING", label: "Pending", badge: "bg-warning/10 text-warning", dot: "bg-warning" },
  { key: "PAUSED", label: "Paused", badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  { key: "ENDED", label: "Ended", badge: "bg-success/10 text-success", dot: "bg-success" },
];

export const PROJECT_STATUS_MAP: Record<ProjectStatus, ProjectStatusDef> = Object.fromEntries(
  PROJECT_STATUSES.map((s) => [s.key, s]),
) as Record<ProjectStatus, ProjectStatusDef>;

// ---------------------------------------------------------------------------
// Event types — used by calendar-view (legend, chips, detail, select).
// ---------------------------------------------------------------------------

export interface EventTypeDef {
  key: EventType;
  label: string;
  dot: string;
  bg: string;
}

export const EVENT_TYPES: EventTypeDef[] = [
  { key: "MEETING", label: "Meeting", dot: "bg-primary", bg: "bg-primary/10" },
  { key: "DEADLINE", label: "Deadline", dot: "bg-destructive", bg: "bg-destructive/10" },
  { key: "REVIEW", label: "Review", dot: "bg-amber-500", bg: "bg-amber-500/10" },
  { key: "SOCIAL", label: "Social", dot: "bg-pink-500", bg: "bg-pink-500/10" },
  { key: "FOCUS", label: "Focus", dot: "bg-emerald-500", bg: "bg-emerald-500/10" },
  // HR module — approved leave, synthesized onto the calendar at read time
  // (dashboard.ts merges them into the event feed; there is no DB row).
  { key: "LEAVE", label: "Leave", dot: "bg-violet-500", bg: "bg-violet-500/10" },
];

export const EVENT_TYPE_MAP: Record<EventType, EventTypeDef> = Object.fromEntries(
  EVENT_TYPES.map((e) => [e.key, e]),
) as Record<EventType, EventTypeDef>;

// ---------------------------------------------------------------------------
// Priority + tag class helpers — these generate the f-priority-* / f-tag-*
// CSS class names defined in globals.css.
// ---------------------------------------------------------------------------

export function priorityClass(p: Priority | string): string {
  return `f-priority-${p.toLowerCase()}`;
}

export function tagClass(t: TaskTag | string): string {
  return `f-tag-${t.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Department labels — used by team-view filter + member-modal select.
// ---------------------------------------------------------------------------

export const DEPARTMENT_LABELS: { key: Department; label: string }[] = [
  { key: "ENGINEERING", label: "Engineering" },
  { key: "DESIGN", label: "Design" },
  { key: "MARKETING", label: "Marketing" },
  { key: "MANAGEMENT", label: "Management" },
];

export function departmentLabel(d: string): string {
  return d.charAt(0) + d.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// P34 (EM-03) — the employment-type grouping axis. A controlled vocabulary
// (the benchmark's Employment Type master collapsed to the workspace-scope
// set), keyed like DEPARTMENT_LABELS so the pickers, the directory filter
// chips, the roster card and the CSV export share one table. QA-19: "" is
// NOT a key — it is the unclassified state, rendered "—" / "Not set".
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPE_LABELS: { key: string; label: string }[] = [
  { key: "FULL_TIME", label: "Full-time" },
  { key: "PART_TIME", label: "Part-time" },
  { key: "CONTRACT", label: "Contract" },
  { key: "INTERN", label: "Intern" },
  { key: "CONSULTANT", label: "Consultant" },
];

export const EMPLOYMENT_TYPE_KEYS = EMPLOYMENT_TYPE_LABELS.map((t) => t.key);

/** Key → display label; an unknown key renders raw, never silently blank
 * (the DEPARTMENT_LABELS discipline — data integrity beats silence). */
export function employmentTypeLabel(key: string): string {
  if (!key) return "";
  return EMPLOYMENT_TYPE_LABELS.find((t) => t.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Bug tracking — severity, priority, status, resolution labels + styles.
// Used by bugs-view (badges, filters), bug-modal (selects), bug-detail
// (lifecycle timeline), and server-actions (audit detail strings).
// ---------------------------------------------------------------------------

export interface BugSeverityDef {
  key: BugSeverity;
  label: string;
  /** Tailwind bg class for the badge. */
  badge: string;
  /** Tailwind text color class. */
  dot: string;
}

export const BUG_SEVERITIES: BugSeverityDef[] = [
  { key: "CRITICAL", label: "Critical", badge: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "bg-red-500" },
  { key: "MAJOR", label: "Major", badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400", dot: "bg-orange-500" },
  { key: "MINOR", label: "Minor", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { key: "TRIVIAL", label: "Trivial", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400", dot: "bg-zinc-400" },
];

export const BUG_SEVERITY_LABELS: Record<BugSeverity, string> = Object.fromEntries(
  BUG_SEVERITIES.map((s) => [s.key, s.label]),
) as Record<BugSeverity, string>;

export const BUG_SEVERITY_BADGE: Record<BugSeverity, string> = Object.fromEntries(
  BUG_SEVERITIES.map((s) => [s.key, s.badge]),
) as Record<BugSeverity, string>;

export interface BugPriorityDef {
  key: BugPriority;
  label: string;
  badge: string;
}

export const BUG_PRIORITIES: BugPriorityDef[] = [
  { key: "P0", label: "P0 — Urgent", badge: "bg-red-500/10 text-red-700 dark:text-red-400" },
  { key: "P1", label: "P1 — High", badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400" },
  { key: "P2", label: "P2 — Medium", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  { key: "P3", label: "P3 — Low", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400" },
];

export const BUG_PRIORITY_LABELS: Record<BugPriority, string> = Object.fromEntries(
  BUG_PRIORITIES.map((p) => [p.key, p.label]),
) as Record<BugPriority, string>;

export interface BugStatusDef {
  key: BugStatus;
  label: string;
  badge: string;
  dot: string;
}

export const BUG_STATUSES: BugStatusDef[] = [
  { key: "NEW", label: "New", badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400", dot: "bg-blue-500" },
  { key: "TRIAGED", label: "Triaged", badge: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400", dot: "bg-indigo-500" },
  { key: "IN_PROGRESS", label: "In Progress", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { key: "IN_REVIEW", label: "In Review", badge: "bg-purple-500/10 text-purple-700 dark:text-purple-400", dot: "bg-purple-500" },
  { key: "RESOLVED", label: "Resolved", badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
  { key: "CLOSED", label: "Closed", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400", dot: "bg-zinc-400" },
  { key: "REOPENED", label: "Reopened", badge: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "bg-red-500" },
];

export const BUG_STATUS_LABELS: Record<BugStatus, string> = Object.fromEntries(
  BUG_STATUSES.map((s) => [s.key, s.label]),
) as Record<BugStatus, string>;

export const BUG_STATUS_BADGE: Record<BugStatus, string> = Object.fromEntries(
  BUG_STATUSES.map((s) => [s.key, s.badge]),
) as Record<BugStatus, string>;

export const BUG_RESOLUTIONS: { key: BugResolution; label: string }[] = [
  { key: "FIXED", label: "Fixed" },
  { key: "WONT_FIX", label: "Won't Fix" },
  { key: "DUPLICATE", label: "Duplicate" },
  { key: "CANNOT_REPRODUCE", label: "Cannot Reproduce" },
  { key: "WORKS_AS_INTENDED", label: "Works as Intended" },
];

export const BUG_RESOLUTION_LABELS: Record<BugResolution, string> = Object.fromEntries(
  BUG_RESOLUTIONS.map((r) => [r.key, r.label]),
) as Record<BugResolution, string>;

/**
 * Valid lifecycle transitions. A status NOT in this map for the current
 * status means the transition is rejected. Enforced by changeBugStatus.
 */
export const BUG_STATUS_TRANSITIONS: Record<BugStatus, BugStatus[]> = {
  NEW: ["TRIAGED", "IN_PROGRESS", "CLOSED"],
  TRIAGED: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["IN_REVIEW", "RESOLVED", "CLOSED"],
  IN_REVIEW: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["REOPENED", "CLOSED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["IN_PROGRESS", "CLOSED"],
};

// ---------------------------------------------------------------------------
// HR module — leave management status definitions (docs/HR_MODULE_PLAN.md).
// PENDING → APPROVED | REJECTED; PENDING/APPROVED → CANCELLED (balance is
// restored on cancel-after-approval).
// ---------------------------------------------------------------------------

export interface LeaveStatusDef {
  key: LeaveStatus;
  label: string;
  badge: string;
  dot: string;
}

export const LEAVE_STATUSES: LeaveStatusDef[] = [
  { key: "PENDING", label: "Pending", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { key: "APPROVED", label: "Approved", badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
  { key: "REJECTED", label: "Rejected", badge: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "bg-red-500" },
  { key: "CANCELLED", label: "Cancelled", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400", dot: "bg-zinc-400" },
];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = Object.fromEntries(
  LEAVE_STATUSES.map((s) => [s.key, s.label]),
) as Record<LeaveStatus, string>;

export const LEAVE_STATUS_BADGE: Record<LeaveStatus, string> = Object.fromEntries(
  LEAVE_STATUSES.map((s) => [s.key, s.badge]),
) as Record<LeaveStatus, string>;

export const LEAVE_STATUS_TRANSITIONS: Record<LeaveStatus, LeaveStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["CANCELLED"],
  REJECTED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// F1.3 — attendance status definitions (docs/Fernly_HR_Payroll_Enhancement_
// Plan.md §7.1). HR/admin marks the first four (attendance:manage);
// ON_LEAVE is derived from approved leave and never form-submitted.
// ---------------------------------------------------------------------------

export interface AttendanceStatusDef {
  key: AttendanceStatus;
  label: string;
  badge: string;
  dot: string;
}

export const ATTENDANCE_STATUSES: AttendanceStatusDef[] = [
  { key: "PRESENT", label: "Present", badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
  { key: "ABSENT", label: "Absent", badge: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "bg-red-500" },
  { key: "HALF_DAY", label: "Half day", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { key: "WFH", label: "WFH", badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400", dot: "bg-blue-500" },
  { key: "ON_LEAVE", label: "On leave", badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400", dot: "bg-violet-500" },
];

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = Object.fromEntries(
  ATTENDANCE_STATUSES.map((s) => [s.key, s.label]),
) as Record<AttendanceStatus, string>;

export const ATTENDANCE_STATUS_BADGE: Record<AttendanceStatus, string> = Object.fromEntries(
  ATTENDANCE_STATUSES.map((s) => [s.key, s.badge]),
) as Record<AttendanceStatus, string>;

/** Single-letter grid code per status (the HR month grid renders compact
 * cells — one letter + the badge color, full label on hover). */
export const ATTENDANCE_STATUS_CODE: Record<AttendanceStatus, string> = {
  PRESENT: "P",
  ABSENT: "A",
  HALF_DAY: "H",
  WFH: "W",
  ON_LEAVE: "L",
};

// ---------------------------------------------------------------------------
// HR module — performance review status definitions (docs/HR_MODULE_PLAN.md
// §6). DRAFT → SUBMITTED → REVIEWED → ACKNOWLEDGED (terminal).
// ---------------------------------------------------------------------------

export interface ReviewStatusDef {
  key: ReviewStatus;
  label: string;
  badge: string;
  dot: string;
}

export const REVIEW_STATUSES: ReviewStatusDef[] = [
  { key: "DRAFT", label: "Draft", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400", dot: "bg-zinc-500" },
  { key: "SUBMITTED", label: "Submitted", badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400", dot: "bg-blue-500" },
  { key: "REVIEWED", label: "Reviewed", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { key: "ACKNOWLEDGED", label: "Acknowledged", badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
];

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = Object.fromEntries(
  REVIEW_STATUSES.map((s) => [s.key, s.label]),
) as Record<ReviewStatus, string>;

export const REVIEW_STATUS_BADGE: Record<ReviewStatus, string> = Object.fromEntries(
  REVIEW_STATUSES.map((s) => [s.key, s.badge]),
) as Record<ReviewStatus, string>;

export const REVIEW_STATUS_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["REVIEWED"],
  REVIEWED: ["ACKNOWLEDGED"],
  ACKNOWLEDGED: [],
};
