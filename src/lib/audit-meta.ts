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
  ClipboardCheck,
  KeyRound, FileText, FileWarning, XCircle, Landmark, Lock, FilePenLine, FilePlus2,
  BookOpen, ListChecks, MessageSquareText, CalendarClock, BadgeCheck,
  Scale, CircleDollarSign, Undo2, HeartPulse, Award,
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
  | "auth.token_issued" // PR-54 — JWT bearer-token minted (/api/auth/token or issueAuthToken)
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
  // LV-10 (S9) — the HR leave adjustment writer (ADJUST ledger rows).
  | "hr.leave_adjusted"
  // F1.1 — holiday calendar lifecycle
  // (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1)
  | "hr.holiday_created"
  | "hr.holiday_updated"
  | "hr.holiday_deleted"
  // F1.3 — attendance records lifecycle (derived ON_LEAVE rows are
  // side effects of leave.approved/leave.cancelled and carry their own
  // audit entries — no per-row spam).
  | "hr.attendance_marked"
  | "hr.attendance_updated"
  | "hr.attendance_deleted"
  // F1.6 — employment lifecycle transitions (guarded action; one entry per
  // status change, from → to recorded in the detail line)
  | "hr.employment_transitioned"
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
  | "onboarding.task_undone"
  // F2.10 (F-R8) — the configurable default-template source.
  | "onboarding.template_task_saved"
  | "onboarding.template_task_deleted"
  // F2.1 — offboarding & full-and-final lite (docs/Fernly_HR_Payroll_
  // Enhancement_Plan.md §7.2): the separation checklist rides the
  // onboarding task actions above; these are the exit-specific writers.
  | "hr.separation_checklist_created"
  | "hr.exit_interview_recorded"
  | "hr.exit_interview_scheduled"
  | "hr.exit_interview_completed"
  | "hr.exit_interview_cancelled"
  | "hr.fnf_generated"
  | "hr.fnf_settled"
  // Recruitment module lifecycle (docs/RECRUITMENT_MODULE_PLAN.md)
  | "hiring.candidate_created"
  | "hiring.candidate_updated"
  | "hiring.candidate_deleted"
  | "hiring.stage_advanced"
  | "hiring.stage_status_changed"
  | "hiring.stage_added"
  | "hiring.decided"
  | "hiring.stage_template_saved"
  | "hiring.stage_template_deleted"
  // Recruitment R2 — interview scheduling + scorecards
  | "hiring.interview_scheduled"
  | "hiring.interview_rescheduled"
  | "hiring.scorecard_saved"
  // Recruitment R3 — decisions & candidate email outbox
  | "hiring.email_queued"
  // Recruitment R4 — joining formalities (documents + background checks)
  | "hiring.doc_type_saved"
  | "hiring.doc_type_deleted"
  | "hiring.document_requested"
  | "hiring.document_received"
  | "hiring.document_verified"
  | "hiring.document_rejected"
  | "hiring.bg_check_initiated"
  | "hiring.bg_check_updated"
  // Recruitment R5 — offer builder
  | "hiring.offer_template_saved"
  | "hiring.offer_template_deleted"
  | "hiring.offer_created"
  | "hiring.offer_updated"
  // Recruitment R6 — e-sign + joining
  | "hiring.offer_sent"
  | "hiring.offer_signed"
  | "hiring.offer_declined"
  | "hiring.candidate_joined"
  // F2.10 — joining hardening: the manager approval step (R11/D-20) and
  // the lazy EXPIRED lapse (F-R5).
  | "hiring.offer_approved"
  | "hiring.offers_lapsed"
  // Recruitment R7 — payroll (ADMIN + HR only)
  | "payroll.structure_saved"
  | "payroll.structure_from_offer"
  | "payroll.run_created"
  | "payroll.payslip_updated"
  | "payroll.payslip_added"
  | "payroll.run_locked"
  | "payroll.component_created"
  | "payroll.component_updated"
  | "payroll.component_deleted"
  // P1 (PR-12/PR-B10, F2.3) — the adjustment adapter: the manual writer
  // and the explicit apply-to-open-run consumption.
  | "payroll.adjustment_created"
  | "payroll.adjustments_applied"
  // P2 (LV-09, F2.2) — leave encashment riding the adapter.
  // P3 (PR-13/PR-B11, F3.1) — arrears reverse-simulation.
  | "payroll.arrears_generated"
  // P4 (PR-14/PR-B12, F3.1) — LWP correction reversal.
  | "payroll.lwp_credit_created"
  // P5 (PR-15–18, F3.2) — flexible benefits.
  | "payroll.benefit_elected"
  | "payroll.benefit_election_cancelled"
  | "payroll.benefit_claimed"
  | "payroll.benefits_accrued"
  // P6 (PR-20/PR-23, PR-T01) — retention bonus.
  | "payroll.retention_bonus_created"
  // P7 (PR-20/PR-21, F3.3) — gratuity rule.
  | "payroll.gratuity_rule_saved"
  // P8 (PR-19/PR-B13, F3.3) — salary withholding.
  | "payroll.withholding_created"
  | "payroll.withholding_released"
  | "leave.encashment_requested"
  | "leave.encashment_approved"
  | "leave.encashment_rejected";

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
  "auth.token_issued": { icon: KeyRound, cls: "text-muted-foreground bg-muted" },
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
  "hr.leave_adjusted": { icon: Scale, cls: "text-sky-500 bg-sky-500/10" },
  "hr.holiday_created": { icon: CalendarPlus, cls: "text-primary bg-primary/10" },
  "hr.holiday_updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "hr.holiday_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "hr.attendance_marked": { icon: ClipboardCheck, cls: "text-emerald-600 bg-emerald-500/10" },
  "hr.employment_transitioned": { icon: ArrowRightLeft, cls: "text-amber-500 bg-amber-500/10" },
  "hr.attendance_updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "hr.attendance_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "review.created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "review.updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "review.submitted": { icon: Send, cls: "text-blue-500 bg-blue-500/10" },
  "review.reviewed": { icon: CheckCircle2, cls: "text-amber-500 bg-amber-500/10" },
  "review.acknowledged": { icon: ShieldCheck, cls: "text-emerald-500 bg-emerald-500/10" },

  "onboarding.created": { icon: Plus, cls: "text-primary bg-primary/10" },
  "onboarding.task_added": { icon: Plus, cls: "text-blue-500 bg-blue-500/10" },
  "hr.separation_checklist_created": { icon: ListChecks, cls: "text-zinc-500 bg-zinc-500/10" },
  "hr.exit_interview_recorded": { icon: MessageSquareText, cls: "text-blue-500 bg-blue-500/10" },
  "hr.exit_interview_scheduled": { icon: CalendarClock, cls: "text-amber-500 bg-amber-500/10" },
  "hr.exit_interview_completed": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "hr.exit_interview_cancelled": { icon: CalendarX, cls: "text-zinc-500 bg-zinc-500/10" },
  "hr.fnf_generated": { icon: FileText, cls: "text-blue-500 bg-blue-500/10" },
  "hr.fnf_settled": { icon: BadgeCheck, cls: "text-emerald-500 bg-emerald-500/10" },
  "onboarding.task_done": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "onboarding.task_undone": { icon: RotateCcw, cls: "text-zinc-500 bg-zinc-500/10" },
  "onboarding.template_task_saved": { icon: Plus, cls: "text-primary bg-primary/10" },
  "onboarding.template_task_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },

  "hiring.candidate_created": { icon: UserPlus, cls: "text-primary bg-primary/10" },
  "hiring.candidate_updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "hiring.candidate_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "hiring.stage_advanced": { icon: ArrowRightLeft, cls: "text-amber-500 bg-amber-500/10" },
  "hiring.stage_status_changed": { icon: ArrowRightLeft, cls: "text-indigo-500 bg-indigo-500/10" },
  "hiring.stage_added": { icon: Plus, cls: "text-indigo-500 bg-indigo-500/10" },
  "hiring.decided": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "hiring.stage_template_saved": { icon: Settings, cls: "text-purple-500 bg-purple-500/10" },
  "hiring.stage_template_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "hiring.interview_scheduled": { icon: CalendarPlus, cls: "text-indigo-500 bg-indigo-500/10" },
  "hiring.interview_rescheduled": { icon: CalendarPlus, cls: "text-amber-500 bg-amber-500/10" },
  "hiring.scorecard_saved": { icon: ClipboardCheck, cls: "text-emerald-500 bg-emerald-500/10" },
  "hiring.email_queued": { icon: Send, cls: "text-sky-500 bg-sky-500/10" },
  "hiring.doc_type_saved": { icon: Settings, cls: "text-purple-500 bg-purple-500/10" },
  "hiring.doc_type_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "hiring.document_requested": { icon: FileText, cls: "text-amber-500 bg-amber-500/10" },
  "hiring.document_received": { icon: FileText, cls: "text-indigo-500 bg-indigo-500/10" },
  "hiring.document_verified": { icon: ShieldCheck, cls: "text-emerald-500 bg-emerald-500/10" },
  "hiring.document_rejected": { icon: FileWarning, cls: "text-destructive bg-destructive/10" },
  "hiring.bg_check_initiated": { icon: ShieldCheck, cls: "text-sky-500 bg-sky-500/10" },
  "hiring.bg_check_updated": { icon: ShieldCheck, cls: "text-amber-500 bg-amber-500/10" },
  "hiring.offer_template_saved": { icon: Settings, cls: "text-purple-500 bg-purple-500/10" },
  "hiring.offer_template_deleted": { icon: Trash2, cls: "text-destructive bg-destructive/10" },
  "hiring.offer_created": { icon: FileText, cls: "text-emerald-500 bg-emerald-500/10" },
  "hiring.offer_updated": { icon: Pencil, cls: "text-blue-500 bg-blue-500/10" },
  "hiring.offer_sent": { icon: Send, cls: "text-indigo-500 bg-indigo-500/10" },
  "hiring.offer_approved": { icon: ClipboardCheck, cls: "text-sky-500 bg-sky-500/10" },
  "hiring.offers_lapsed": { icon: Clock, cls: "text-zinc-500 bg-zinc-500/10" },
  "hiring.offer_signed": { icon: ClipboardCheck, cls: "text-emerald-500 bg-emerald-500/10" },
  "hiring.offer_declined": { icon: XCircle, cls: "text-destructive bg-destructive/10" },
  "hiring.candidate_joined": { icon: UserPlus, cls: "text-emerald-500 bg-emerald-500/10" },
  "payroll.structure_saved": { icon: Landmark, cls: "text-purple-500 bg-purple-500/10" },
  "payroll.structure_from_offer": { icon: Landmark, cls: "text-indigo-500 bg-indigo-500/10" },
  "payroll.run_created": { icon: CalendarPlus, cls: "text-sky-500 bg-sky-500/10" },
  "payroll.payslip_updated": { icon: FilePenLine, cls: "text-amber-500 bg-amber-500/10" },
  "payroll.payslip_added": { icon: FilePlus2, cls: "text-indigo-500 bg-indigo-500/10" },
  "payroll.run_locked": { icon: Lock, cls: "text-emerald-500 bg-emerald-500/10" },
  "payroll.component_created": { icon: BookOpen, cls: "text-teal-500 bg-teal-500/10" },
  "payroll.component_updated": { icon: BookOpen, cls: "text-teal-500 bg-teal-500/10" },
  "payroll.component_deleted": { icon: BookOpen, cls: "text-rose-500 bg-rose-500/10" },
  "payroll.adjustment_created": { icon: CircleDollarSign, cls: "text-teal-500 bg-teal-500/10" },
  "payroll.adjustments_applied": { icon: CircleDollarSign, cls: "text-sky-500 bg-sky-500/10" },
  "payroll.arrears_generated": { icon: RotateCcw, cls: "text-indigo-500 bg-indigo-500/10" },
  "payroll.lwp_credit_created": { icon: Undo2, cls: "text-teal-500 bg-teal-500/10" },
  "payroll.benefit_elected": { icon: HeartPulse, cls: "text-pink-500 bg-pink-500/10" },
  "payroll.benefit_election_cancelled": { icon: HeartPulse, cls: "text-zinc-500 bg-zinc-500/10" },
  "payroll.benefit_claimed": { icon: HeartPulse, cls: "text-sky-500 bg-sky-500/10" },
  "payroll.benefits_accrued": { icon: HeartPulse, cls: "text-emerald-500 bg-emerald-500/10" },
  "payroll.retention_bonus_created": { icon: Award, cls: "text-amber-500 bg-amber-500/10" },
  "payroll.gratuity_rule_saved": { icon: Scale, cls: "text-violet-500 bg-violet-500/10" },
  "payroll.withholding_created": { icon: Clock, cls: "text-orange-500 bg-orange-500/10" },
  "payroll.withholding_released": { icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  "leave.encashment_requested": { icon: CircleDollarSign, cls: "text-amber-500 bg-amber-500/10" },
  "leave.encashment_approved": { icon: CircleDollarSign, cls: "text-emerald-500 bg-emerald-500/10" },
  "leave.encashment_rejected": { icon: CircleDollarSign, cls: "text-rose-500 bg-rose-500/10" },
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
  CANDIDATE: { label: "Candidate", cls: "bg-teal-500/10 text-teal-700" },
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
  { key: "hiring", label: "Hiring", types: ["CANDIDATE"] },
  { key: "people", label: "People & Access", types: ["MEMBER", "USER", "ROLE"] },
  { key: "events", label: "Calendar", types: ["EVENT"] },
  { key: "messages", label: "Messages", types: ["MESSAGE"] },
  { key: "other", label: "Other", types: ["REMINDER", "TIME", "AUTH", "WORKSPACE", "CONFIG"] },
];
