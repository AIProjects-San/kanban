// ---------------------------------------------------------------------------
// G4 — the timesheet kernel (the pure status machine + hours math every
// side imports: the actions, the review UI, the future payroll bridge).
//
// The lifecycle (the G6/ADR-019 discipline):
//   DRAFT → SUBMITTED → APPROVED → LOCKED
//   REJECTED → DRAFT (the re-submission path — a rejection returns the
//   document to its author, it never dead-ends)
// LOCKED is written only by the payroll lock that consumed the document
// (the encashment PAID precedent). Approval is four-eyes on the SUBJECT:
// the approver must differ from the employee whose hours these are (a
// MANAGER's own timesheet needs a different pair of eyes — the G6 rule,
// not the leave rule).
//
// Hours are Float (the codebase money convention, ADR-020 — the same
// round2 materialization discipline applies to every hours sum).
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/shared/money";
import { dayKey, parseDay } from "@/lib/hr/working-days";

export const TIMESHEET_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "LOCKED",
  "REJECTED",
] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

export const TIMESHEET_STATUS_LABELS: Record<TimesheetStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted — awaiting review",
  APPROVED: "Approved",
  LOCKED: "Locked (consumed by payroll)",
  REJECTED: "Rejected — returned to draft",
};

/** The one-line status badge tone (mirrors the G6/loan badge maps). */
export const TIMESHEET_STATUS_BADGE: Record<TimesheetStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-amber-500/10 text-amber-700",
  APPROVED: "bg-emerald-500/10 text-emerald-700",
  LOCKED: "bg-sky-500/10 text-sky-700",
  REJECTED: "bg-destructive/10 text-destructive",
};

/** The legal forward graph. REJECTED's only exit is back to DRAFT (the
 * author edits and re-submits); LOCKED is terminal (the payroll that
 * consumed it is immutable by definition). */
export const TIMESHEET_TRANSITIONS: Record<TimesheetStatus, TimesheetStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED"],
  APPROVED: ["LOCKED"],
  LOCKED: [],
  REJECTED: ["DRAFT"],
};

export function canTransitionTimesheet(from: string, to: string): boolean {
  const edges = TIMESHEET_TRANSITIONS[from as TimesheetStatus];
  return Array.isArray(edges) && edges.includes(to as TimesheetStatus);
}

/** Statuses whose lines the author may still edit (the draft family). */
export const EDITABLE_TIMESHEET_STATUSES: TimesheetStatus[] = ["DRAFT", "REJECTED"];

export function isEditableTimesheet(status: string): boolean {
  return EDITABLE_TIMESHEET_STATUSES.includes(status as TimesheetStatus);
}

/** Four-eyes on the subject: nobody approves their own hours. (HR may
 * well have CREATED the draft on the employee's behalf — that is fine;
 * the approver must only differ from the employee.) */
export function canApproveTimesheet(employeeId: string, approverId: string): boolean {
  return employeeId !== approverId;
}

// ---------------------------------------------------------------------------
// Hours math
// ---------------------------------------------------------------------------

/** Σ line hours, materialized to cents (the ADR-020 discipline: every
 * repeated-sum writes a round2 at its materialization point). */
export function sumLineHours(lines: Array<{ hours: number }>): number {
  return round2(lines.reduce((s, l) => s + (Number.isFinite(l.hours) ? l.hours : 0), 0));
}

/** Overtime hours = Σ hours on rows flagged isOvertime (the review's
 * headline number — the payout itself stays the P9 bridge's business). */
export function overtimeHours(lines: Array<{ hours: number; isOvertime?: boolean }>): number {
  return round2(
    lines.reduce((s, l) => (l.isOvertime && Number.isFinite(l.hours) ? s + l.hours : s), 0),
  );
}

/** Billable hours = Σ hours on rows flagged isBillable. */
export function billableHours(lines: Array<{ hours: number; isBillable?: boolean }>): number {
  return round2(
    lines.reduce((s, l) => (l.isBillable && Number.isFinite(l.hours) ? s + l.hours : s), 0),
  );
}

/** The line-level validation twin (the pure guard for tests and non-zod
 * callers): hours in (0, 24], the work day inside the sheet's period. */
export function isValidTimesheetLine(input: {
  hours: number;
  workDay: string;
  periodStartDay: string;
  periodEndDay: string;
}): string | null {
  if (!(input.hours > 0) || input.hours > 24) {
    return "Each line's hours must be between 0 and 24.";
  }
  const t = parseDay(input.workDay).getTime();
  if (!(t >= parseDay(input.periodStartDay).getTime()) || !(t <= parseDay(input.periodEndDay).getTime())) {
    return "Each line's work day must fall inside the timesheet's period.";
  }
  return null;
}

/** True when the sheet's [periodStart, periodEnd] contains the given
 * window — the "an APPROVED timesheet for the period" predicate the
 * payroll bridge will consume (a weekly sheet does NOT cover a monthly
 * run; a monthly sheet covers every weekly run inside it). */
export function timesheetCoversWindow(
  sheet: { periodStart: Date | string; periodEnd: Date | string },
  window: { start: Date; end: Date },
): boolean {
  const s = typeof sheet.periodStart === "string" ? parseDay(sheet.periodStart) : sheet.periodStart;
  const e = typeof sheet.periodEnd === "string" ? parseDay(sheet.periodEnd) : sheet.periodEnd;
  // DAY granularity: the sheet's bounds are UTC midnights while a payroll
  // window's end is end-of-day — 2026-11-30T00:00 must still cover a
  // window ending 2026-11-30T23:59 (dayKey compares the ISO days).
  return dayKey(s) <= dayKey(window.start) && dayKey(e) >= dayKey(window.end);
}

// ---------------------------------------------------------------------------
// The payroll bridge math (pure — the reviewed createPayrollRun hook will
// call exactly this; see the G4 report for the hook's proposed diff)
// ---------------------------------------------------------------------------

/** The standard hours per working day the bridge assumes (the workspace
 * default day 09:00–17:30 carries a 30-min break = 8h; exposed so the
 * hook and its tests agree on one constant). */
export const STANDARD_HOURS_PER_WORKING_DAY = 8;

/** The hours → paid-days translation the payroll hook needs: an approved
 * timesheet's totalHours overrides the derived (employment-window)
 * working-day count as the proration numerator —
 *   paidDays = totalHours / 8
 * so a 140h month on a 20-working-day period prorates earnings by
 * 140/8/20 = 0.875, exactly as 17.5 paid days would. Clamped to [0,
 * 7 × days] so a fat-fingered 400h sheet cannot pay 50 days. */
export function hoursToPaidDays(totalHours: number, workingDays: number): number {
  const days = Math.max(0, Math.floor(workingDays));
  const raw = totalHours / STANDARD_HOURS_PER_WORKING_DAY;
  const max = 7 * Math.max(1, days);
  return round2(Math.min(Math.max(0, raw), max));
}

/** Today as an ISO day (UTC) — the kernel's single "now" derivation. */
export function timesheetToday(now: Date = new Date()): string {
  return dayKey(now);
}
