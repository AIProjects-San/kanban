// ---------------------------------------------------------------------------
// F1.6 — employment lifecycle vocabulary and transition machine
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1, decision §9.3).
//
// Type definitions live in lib/types (the shared-type convention); this
// module carries the runtime vocabulary:
//
// The ONLY writer of EmployeeProfile.employmentStatus is the guarded
// transitionEmployment action (src/server-actions/employment.ts); this
// module is the pure vocabulary every layer shares:
//
//   • the status set ("" = not tracked yet, the QA-19 no-fabrication value —
//     a self-created profile claims no employment fact HR never asserted)
//   • the legal transition graph (mirrors BUG_STATUS_TRANSITIONS' shape)
//   • UI labels/badges ("" renders as "—", like DEPARTMENT_LABELS)
//   • the probation-end default: hireDate + PROBATION_DEFAULT_MONTHS
//
// Transition graph (§9.3 hard gate enforced in the action, not here — the
// gate needs the review table; this module stays pure):
//
//     ""        → PROBATION | ACTIVE | EXITED
//     PROBATION → ACTIVE (gated) | EXITED
//     ACTIVE    → SUSPENDED | EXITED
//     SUSPENDED → ACTIVE | EXITED
//     EXITED    → (terminal)
//
// PROBATION → SUSPENDED is deliberately ABSENT: suspension is for active
// employees, and allowing it would route around the §9.3 gate via
// suspend → reinstate (PROBATION → SUSPENDED → ACTIVE with no review). A
// probationer who must be removed mid-probation is EXITED instead — a
// failed probation, which is exactly what that path means. Reinstatement
// from SUSPENDED lands on ACTIVE deliberately: suspension is an explicit,
// audited HR decision, and the person was ACTIVE before it.
// ---------------------------------------------------------------------------

import type { EmploymentStatus, ReviewKind } from "@/lib/types";

export type { EmploymentStatus, ReviewKind };

/** Probation review cycle kind on PerformanceReview (F1.6). */
export const REVIEW_KINDS: ReviewKind[] = ["STANDARD", "PROBATION"];

export const EMPLOYMENT_STATUSES: EmploymentStatus[] = ["", "PROBATION", "ACTIVE", "SUSPENDED", "EXITED"];

export interface EmploymentStatusDef {
  key: EmploymentStatus;
  label: string;
  badge: string;
}

export const EMPLOYMENT_STATUS_DEFS: EmploymentStatusDef[] = [
  { key: "", label: "Not set", badge: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400" },
  { key: "PROBATION", label: "Probation", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  { key: "ACTIVE", label: "Active", badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  { key: "SUSPENDED", label: "Suspended", badge: "bg-red-500/10 text-red-700 dark:text-red-400" },
  { key: "EXITED", label: "Exited", badge: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-500" },
];

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = Object.fromEntries(
  EMPLOYMENT_STATUS_DEFS.map((s) => [s.key, s.label]),
) as Record<EmploymentStatus, string>;

export const EMPLOYMENT_STATUS_BADGE: Record<EmploymentStatus, string> = Object.fromEntries(
  EMPLOYMENT_STATUS_DEFS.map((s) => [s.key, s.badge]),
) as Record<EmploymentStatus, string>;

/** Legal transitions (the §9.3 gate is layered on top in the action). */
export const EMPLOYMENT_STATUS_TRANSITIONS: Record<EmploymentStatus, EmploymentStatus[]> = {
  "": ["PROBATION", "ACTIVE", "EXITED"],
  PROBATION: ["ACTIVE", "EXITED"],
  ACTIVE: ["SUSPENDED", "EXITED"],
  SUSPENDED: ["ACTIVE", "EXITED"],
  EXITED: [],
};

export function isEmploymentStatus(value: unknown): value is EmploymentStatus {
  return typeof value === "string" && (EMPLOYMENT_STATUSES as string[]).includes(value);
}

export function canTransition(from: EmploymentStatus, to: EmploymentStatus): boolean {
  return EMPLOYMENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The review statuses that satisfy the §9.3 gate — the manager's verdict is
 * in (REVIEWED) and the employee may have acknowledged it (ACKNOWLEDGED).
 * DRAFT/SUBMITTED cycles are "outstanding", as is having no PROBATION-kind
 * review at all. */
export const PROBATION_REVIEW_SATISFIED_STATUSES = ["REVIEWED", "ACKNOWLEDGED"] as const;

/** Default probation length applied when HR starts probation without an
 * explicit end date (hireDate feeds probation defaults — plan §7.1 F1.6). */
export const PROBATION_DEFAULT_MONTHS = 3;

/** probationEndsAt default: hireDate + PROBATION_DEFAULT_MONTHS. Pure date
 * arithmetic (UTC, calendar months). JavaScript's setUTCMonth OVERFLOWS a
 * day-31 hire into the next month (Jan 31 + 3 → May 1); the business
 * meaning of "3 months of probation" saturates instead (Jan 31 + 3 → Apr
 * 30) — the same clamping frappe's add_months applies — so the day is
 * clamped to the target month's last day explicitly. */
export function defaultProbationEndsAt(hireDate: Date): Date {
  const d = new Date(hireDate.getTime());
  const day = d.getUTCDate();
  // Move to the 1st before shifting months so the shift itself never
  // overflows; the original day is re-applied (clamped) afterwards.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + PROBATION_DEFAULT_MONTHS);
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInTargetMonth));
  return d;
}

/** Serialize a nullable date column to the wire format used across the HR
 * actions (ISO yyyy-mm-dd), null staying null. */
export function isoDateOrNull(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
