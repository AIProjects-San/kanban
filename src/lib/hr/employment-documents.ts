// ---------------------------------------------------------------------------
// P1 G6 — the Employee Transfer / Employee Promotion document kernel.
//
// The pure status machine and date rules behind the two approval-gated
// employment documents (prisma EmployeeTransfer / EmployeePromotion). This
// module owns the rules every caller rides; the db-coupled effect core
// lives in lib/hr/employment-doc-effect.ts, the server actions in
// server-actions/hr-employment-docs.ts, and the daily effective-date sweep
// in the same effect module (the encashment-auto-draft posture: pure rules
// here, rows there).
//
// Status graph (spec §2):
//   DRAFT → PENDING_APPROVAL   HR/Admin submits (future effective date only)
//   PENDING_APPROVAL → APPROVED  a different pair of eyes approves
//   APPROVED → EFFECTIVE        on/after the effective date — the daily
//                               sweep or a manual admin trigger; the ONLY
//                               state that writes profile facts
//   any pre-EFFECTIVE state → CANCELLED  the creator (ADMIN as the safety
//                               valve for an orphaned APPROVED document)
//   EFFECTIVE / CANCELLED are terminal.
//
// The flips themselves are guarded status-in-WHERE updateMany calls (the
// QA-16 leave discipline — two concurrent approvers cannot both win).
// ---------------------------------------------------------------------------

import type { EmploymentChangeKind } from "./employment-change";

/** The two document kinds (the benchmark's Promotion / Transfer doctypes). */
export type EmploymentDocKind = EmploymentChangeKind; // "PROMOTION" | "TRANSFER"

export const EMPLOYMENT_DOC_KINDS: EmploymentDocKind[] = ["TRANSFER", "PROMOTION"];

export function isEmploymentDocKind(value: unknown): value is EmploymentDocKind {
  return typeof value === "string" && (EMPLOYMENT_DOC_KINDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Statuses.
// ---------------------------------------------------------------------------

export type EmploymentDocStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "EFFECTIVE"
  | "CANCELLED";

export const EMPLOYMENT_DOC_STATUSES: EmploymentDocStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "EFFECTIVE",
  "CANCELLED",
];

export function isEmploymentDocStatus(value: unknown): value is EmploymentDocStatus {
  return (
    typeof value === "string" &&
    (EMPLOYMENT_DOC_STATUSES as string[]).includes(value)
  );
}

export const EMPLOYMENT_DOC_STATUS_LABELS: Record<EmploymentDocStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  EFFECTIVE: "Effective",
  CANCELLED: "Cancelled",
};

/** Tailwind badge classes (the employment-status badge convention). */
export const EMPLOYMENT_DOC_STATUS_BADGE: Record<EmploymentDocStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  PENDING_APPROVAL: "bg-amber-500/10 text-amber-600",
  APPROVED: "bg-blue-500/10 text-blue-600",
  EFFECTIVE: "bg-emerald-500/10 text-emerald-600",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

// ---------------------------------------------------------------------------
// The transition graph.
// ---------------------------------------------------------------------------

export const EMPLOYMENT_DOC_TRANSITIONS: Record<EmploymentDocStatus, EmploymentDocStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["EFFECTIVE", "CANCELLED"],
  EFFECTIVE: [],
  CANCELLED: [],
};

/** May the document move from one status to another on the graph? */
export function canTransitionEmploymentDoc(
  from: EmploymentDocStatus,
  to: EmploymentDocStatus,
): boolean {
  return EMPLOYMENT_DOC_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The statuses a document may still be cancelled from (spec §2: the
 * creator, before EFFECTIVE; EFFECTIVE and CANCELLED are terminal). */
export const CANCELABLE_EMPLOYMENT_DOC_STATUSES: EmploymentDocStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
];

// ---------------------------------------------------------------------------
// The date rules (date-only semantics, UTC day keys — the working-days
// convention: "2026-11-13" strings compare lexicographically).
// ---------------------------------------------------------------------------

/**
 * Spec §4: the effective date must be in the FUTURE when the document is
 * submitted — today is not the future (a same-day submission would race the
 * effect gate). Strictly greater than today.
 */
export function isFutureDay(dayKey_: string, todayKey: string): boolean {
  return dayKey_ > todayKey;
}

/**
 * Spec §2/§3: a document may become EFFECTIVE on or after its effective
 * date — the manual trigger's gate and the sweep's due filter share this
 * one rule (the sweep treats "due" as exactly this predicate).
 */
export function isEffectiveDayReached(dayKey_: string, todayKey: string): boolean {
  return dayKey_ <= todayKey;
}

/** The UTC day key of a Date (the dayKey convention). */
export function utcDayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse a yyyy-mm-dd day key into its UTC-midnight Date (the effectiveDate
 * storage convention — every writer passes dates through this one parse). */
export function dayKeyToDate(dayKey_: string): Date {
  return new Date(`${dayKey_}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// The change rules (spec §4) — pure predicates over the string facts the
// documents carry. `current` is the live EmployeeProfile (+ User.managerId)
// state; `to` is the requested end state.
// ---------------------------------------------------------------------------
export interface EmploymentFacts {
  department: string;
  jobTitle: string;
  grade: string;
  location: string;
  managerId: string | null;
}

/** A transfer must carry at least one to-side field. */
export function transferCarriesAnyAxis(to: {
  toDepartment?: string;
  toJobTitle?: string;
  toManagerId?: string | null;
  toLocation?: string;
}): boolean {
  return (
    to.toDepartment !== undefined ||
    to.toJobTitle !== undefined ||
    to.toManagerId !== undefined ||
    to.toLocation !== undefined
  );
}

/**
 * Does the transfer actually change anything? Every provided axis compares
 * against the current fact; an unprovided axis is a no-op. (The spec's
 * same-department / same-designation refusals are handled by the caller
 * BEFORE this — this answers the weaker "anything at all changed?"
 * question for the manager/location axes the spec leaves un-named.)
 */
export function transferChangesAnyFact(
  current: EmploymentFacts,
  to: {
    toDepartment?: string;
    toJobTitle?: string;
    toManagerId?: string | null;
    toLocation?: string;
  },
): boolean {
  if (to.toDepartment !== undefined && to.toDepartment !== current.department) return true;
  if (to.toJobTitle !== undefined && to.toJobTitle !== current.jobTitle) return true;
  if (to.toManagerId !== undefined && (to.toManagerId ?? null) !== current.managerId) return true;
  if (to.toLocation !== undefined && to.toLocation !== current.location) return true;
  return false;
}

/**
 * Does the promotion actually change anything? toJobTitle is required and
 * must differ (checked by the caller with its named refusal); the grade is
 * the optional second axis.
 */
export function promotionChangesAnyFact(
  current: EmploymentFacts,
  to: { toJobTitle: string; toGrade?: string },
): boolean {
  if (to.toJobTitle !== current.jobTitle) return true;
  if (to.toGrade !== undefined && to.toGrade !== current.grade) return true;
  return false;
}
