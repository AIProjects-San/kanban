/**
 * Audit log metadata — centralized mapping from audit action strings to
 * their display icons, colors, and entity-type badges.
 *
 * The `AuditAction` union type is used by both the writer (server-actions/data.ts)
 * and the reader (audit-view.tsx), so a typo on either side is a compile error
 * instead of a silent fallback to the default icon.
 */

import {
  Plus, Pencil, Trash2, ArrowRightLeft, FolderPlus, UserPlus, UserMinus,
  UserCog, CalendarPlus, CalendarX, Send, ShieldCheck, Settings, BellPlus,
  CheckCircle2, RotateCcw, Clock, LogIn, CircleDot, Bug, MessageSquare, Link2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Typed action strings — every `logAudit({ action: ... })` call must use
// one of these. Adding a new action? Add it here first, then use it.
// ---------------------------------------------------------------------------

export type AuditAction =
  | "task.created"
  | "task.updated"
  | "task.moved"
  | "task.deleted"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project.assigned"
  | "project.unassigned"
  | "member.invited"
  | "member.updated"
  | "member.removed"
  | "event.created"
  | "event.deleted"
  | "message.sent"
  | "message.deleted"
  | "role.changed"
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "user.account_created"
  | "profile.updated"
  | "workspace.updated"
  | "config.created"
  | "config.updated"
  | "config.deleted"
  | "reminder.created"
  | "reminder.completed"
  | "reminder.reopened"
  | "time.logged"
  | "auth.signed_in"
  | "auth.signed_out"
  | "auth.password_changed"
  | "audit.pruned" // L-P1-20 — records when the audit log was pruned
  | "project.restored" // L-P2-33 — restored from the trash
  | "user.restored" // L-P2-33
  | "message.restored" // L-P2-33
  // Bug tracking lifecycle
  | "bug.created"
  | "bug.updated"
  | "bug.assigned"
  | "bug.status_changed"
  | "bug.resolved"
  | "bug.reopened"
  | "bug.closed"
  | "bug.commented"
  | "bug.deleted"
  // Board enhancements — Task ↔ Bug links, bug board moves, time-log deletes
  | "bug.linked"
  | "bug.unlinked"
  | "bug.moved"
  | "time.deleted"
  // HR module — leave management lifecycle (docs/HR_MODULE_PLAN.md)
  | "leave.requested"
  | "leave.approved"
  | "leave.rejected"
  | "leave.cancelled"
  | "leave.type_created"
  | "leave.type_updated"
  // HR module — performance review lifecycle (docs/HR_MODULE_PLAN.md §6)
  | "review.created"
  | "review.updated"
  | "review.submitted"
  | "review.reviewed"
  | "review.acknowledged"
  // HR module — onboarding lifecycle (docs/HR_MODULE_PLAN.md §7)
  | "onboarding.created"
  | "onboarding.task_added"
  | "onboarding.task_done"
  | "onboarding.task_undone";

// ---------------------------------------------------------------------------
// Action → { icon, color class } mapping
// ---------------------------------------------------------------------------

export interface AuditActionMeta {
  icon: LucideIcon;
  cls: string;
}

export const ACTION_META: Record<AuditAction, AuditActionMeta> = {
  "task.created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "task.updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "task.moved": { icon: ArrowRightLeft, cls: "text-amber-500 bg-amber-500/10" },
  "task.deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "project.created": { icon: FolderPlus, cls: "text-primary bg-primary/10" },
  "project.updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "project.deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "project.assigned": { icon: UserPlus, cls: "text-success bg-success/10" },
  "project.unassigned": { icon: UserMinus, cls: "text-muted-foreground bg-muted" },

  "member.invited": { icon: UserPlus, cls: "text-primary bg-primary/10" },
  "member.updated": { icon: UserCog, cls: "text-blue-500 bg-blue-500/10" },
  "member.removed": { icon: UserMinus, cls: "text-destructive bg-destructive/10" },

  "event.created": { icon: CalendarPlus, cls: "text-primary bg-primary/10" },
  "event.deleted": { icon: CalendarX, cls: "text-destructive bg-destructive/10" },

  "message.sent": { icon: Send, cls: "text-primary bg-primary/10" },
  "message.deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "role.changed": { icon: ShieldCheck, cls: "text-amber-500 bg-amber-500/10" },

  "user.created": { icon: UserPlus, cls: "text-primary bg-primary/10" },
  "user.updated": { icon: UserCog, cls: "text-blue-500 bg-blue-500/10" },
  "user.deleted": { icon: UserMinus, cls: "text-destructive bg-destructive/10" },
  "user.account_created": { icon: UserPlus, cls: "text-primary bg-primary/10" },

  "profile.updated": { icon: Settings, cls: "text-blue-500 bg-blue-500/10" },
  "workspace.updated": { icon: Settings, cls: "text-purple-500 bg-purple-500/10" },
  "config.created": { icon: Plus, cls: "text-purple-500 bg-purple-500/10" },
  "config.updated": { icon: Pencil, cls: "text-purple-500 bg-purple-500/10" },
  "config.deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "reminder.created": { icon: BellPlus, cls: "text-primary bg-primary/10" },
  "reminder.completed": { icon: CheckCircle2, cls: "text-success bg-success/10" },
  "reminder.reopened": { icon: RotateCcw, cls: "text-amber-500 bg-amber-500/10" },

  "time.logged": { icon: Clock, cls: "text-primary bg-primary/10" },

  "auth.signed_in": { icon: LogIn, cls: "text-muted-foreground bg-muted" },
  "auth.signed_out": { icon: LogIn, cls: "text-muted-foreground bg-muted" },
  "auth.password_changed": { icon: ShieldCheck, cls: "text-success bg-success/10" },
  "audit.pruned": { icon: Clock, cls: "text-muted-foreground bg-muted" },
  "project.restored": { icon: RotateCcw, cls: "text-success bg-success/10" },
  "user.restored": { icon: RotateCcw, cls: "text-success bg-success/10" },
  "message.restored": { icon: RotateCcw, cls: "text-success bg-success/10" },

  "bug.created": { icon: Bug, cls: "text-red-500 bg-red-500/10" },
  "bug.updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "bug.assigned": { icon: UserPlus, cls: "text-indigo-500 bg-indigo-500/10" },
  "bug.status_changed": { icon: ArrowRightLeft, cls: "text-amber-500 bg-amber-500/10" },
  "bug.resolved": { icon: CheckCircle2, cls: "text-success bg-success/10" },
  "bug.reopened": { icon: RotateCcw, cls: "text-red-500 bg-red-500/10" },
  "bug.closed": { icon: CheckCircle2, cls: "text-muted-foreground bg-muted" },
  "bug.commented": { icon: MessageSquare, cls: "text-blue-500 bg-blue-500/10" },
  "bug.deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "bug.linked": { icon: Link2, cls: "text-indigo-500 bg-indigo-500/10" },
  "bug.unlinked": { icon: Link2, cls: "text-muted-foreground bg-muted" },
  "bug.moved": { icon: ArrowRightLeft, cls: "text-amber-500 bg-amber-500/10" },
  "time.deleted": { icon: Clock, cls: "text-destructive bg-destructive/10" },

  "leave.requested": { icon: CalendarPlus, cls: "text-amber-500 bg-amber-500/10" },
  "leave.approved": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "leave.rejected": { icon: CalendarX, cls: "text-red-500 bg-red-500/10" },
  "leave.cancelled": { icon: RotateCcw, cls: "text-zinc-500 bg-zinc-500/10" },
  "leave.type_created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "leave.type_updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },

  "review.created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "review.updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "review.submitted": { icon: Send, cls: "text-blue-500 bg-blue-500/10" },
  "review.reviewed": { icon: CheckCircle2, cls: "text-amber-500 bg-amber-500/10" },
  "review.acknowledged": { icon: ShieldCheck, cls: "text-emerald-500 bg-emerald-500/10" },

  "onboarding.created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "onboarding.task_added": { icon: Plus, cls: "text-blue-500 bg-blue-500/10" },
  "onboarding.task_done": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "onboarding.task_undone": { icon: RotateCcw, cls: "text-zinc-500 bg-zinc-500/10" },
};

/** Fallback for any action string not in the map (should never happen with
 *  the typed `AuditAction` union, but defensive coding for old log entries). */
export const ACTION_META_DEFAULT: AuditActionMeta = {
  icon: CircleDot,
  cls: "text-muted-foreground bg-muted",
};

export function getActionMeta(action: string): AuditActionMeta {
  return (ACTION_META as Record<string, AuditActionMeta>)[action] ?? ACTION_META_DEFAULT;
}

// ---------------------------------------------------------------------------
// Entity type → { label, badge class } mapping
// ---------------------------------------------------------------------------

export interface EntityBadgeMeta {
  label: string;
  cls: string;
}

export const ENTITY_BADGE: Record<string, EntityBadgeMeta> = {
  TASK: { label: "Task", cls: "bg-blue-500/10 text-blue-700" },
  PROJECT: { label: "Project", cls: "bg-primary/10 text-primary" },
  MEMBER: { label: "Member", cls: "bg-purple-500/10 text-purple-700" },
  USER: { label: "User", cls: "bg-emerald-500/10 text-emerald-700" },
  ROLE: { label: "Role", cls: "bg-amber-500/10 text-amber-700" },
  EVENT: { label: "Event", cls: "bg-pink-500/10 text-pink-700" },
  MESSAGE: { label: "Message", cls: "bg-cyan-500/10 text-cyan-700" },
  REMINDER: { label: "Reminder", cls: "bg-orange-500/10 text-orange-700" },
  TIME: { label: "Time", cls: "bg-indigo-500/10 text-indigo-700" },
  AUTH: { label: "Auth", cls: "bg-muted text-muted-foreground" },
  WORKSPACE: { label: "Workspace", cls: "bg-purple-500/10 text-purple-700" },
  CONFIG: { label: "Config", cls: "bg-violet-500/10 text-violet-700" },
  BUG: { label: "Bug", cls: "bg-red-500/10 text-red-700" },
};

export const ENTITY_BADGE_DEFAULT: EntityBadgeMeta = {
  label: "Other",
  cls: "bg-muted text-muted-foreground",
};

export function getEntityBadge(entityType: string): EntityBadgeMeta {
  return ENTITY_BADGE[entityType] ?? ENTITY_BADGE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Audit view filter buckets — groups entity types into UI tabs.
// ---------------------------------------------------------------------------

export interface AuditFilterDef {
  key: string;
  label: string;
  types: string[] | null; // null = "all"
}

export const AUDIT_FILTERS: AuditFilterDef[] = [
  { key: "all", label: "All activity", types: null },
  { key: "tasks", label: "Tasks", types: ["TASK"] },
  { key: "projects", label: "Projects", types: ["PROJECT"] },
  { key: "bugs", label: "Bugs", types: ["BUG"] },
  { key: "people", label: "People & Access", types: ["MEMBER", "USER", "ROLE"] },
  { key: "events", label: "Calendar", types: ["EVENT"] },
  { key: "messages", label: "Messages", types: ["MESSAGE"] },
  { key: "other", label: "Other", types: ["REMINDER", "TIME", "AUTH", "WORKSPACE", "CONFIG"] },
];
