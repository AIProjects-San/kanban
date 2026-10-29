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
