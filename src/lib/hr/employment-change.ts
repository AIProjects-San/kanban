// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01, F2.5-lite) — the structured property-history kernel.
//
// The benchmark's Employee Property History is a CHILD TABLE of Employee:
// one row per (property, current, new) whenever a promotable employment
// property changes, powering the promotion/transfer actions. Fernly's pure
// kernel owns the three rules every caller rides:
//
//   • the promotable property registry — jobTitle / department / grade /
//     manager / location / salary (grade registered at P34/EM-03 when the
//     field landed, location at P1 G6 when transfers started carrying it;
//     the registry is the single place they register)
//   • planEmploymentChange — the diff: ONE row per property whose display
//     value actually changes; unchanged properties record nothing (the
//     no-change change is refused by the writer, never recorded as noise)
//   • raiseStructure — the salary revision: a percent raise scales every
//     FIXED EARNING line (amounts are whole annual units); percent-mode
//     lines ride their basis at resolve time (PERCENT_OF_BASIC grows with
//     basic, PERCENT_OF_GROSS with the grown gross — resolved annually by
//     computeOffer, never re-stated), and deductions / employer
//     contributions / statistical lines ride untouched. One number in,
//     shape preserved, history addressable.
//   • retirementProjection — the EM-B02 display math: birthDate +
//     retirementAge years → the projected month (display-only; nothing
//     gates on it — the retirement-age concept stays declined, this is the
//     display field the sweep's P33 row scopes).
//
// Pure and dependency-free except the offer-math import (itself pure):
// the server action resolves every display string (department label,
// manager name, formatted gross) BEFORE calling; QA-1 re-validation calls
// the same planner inside the transaction (one rule, both callers).
// ---------------------------------------------------------------------------

import { computeOffer, type OfferComponent } from "@/lib/hiring/offer-math";

// ---------------------------------------------------------------------------
// The property registry.
// ---------------------------------------------------------------------------

/** Every property a promotion/transfer may change. Location joined at
 * P1 G6 (transfers carry it; the P33 writers never pass it, so their diffs
 * are unchanged — the planner skips absent keys). */
export type EmploymentProperty =
  | "jobTitle"
  | "department"
  | "grade"
  | "manager"
  | "location"
  | "salary";

export const EMPLOYMENT_PROPERTIES: EmploymentProperty[] = [
  "jobTitle",
  "department",
  "grade",
  "manager",
  "location",
  "salary",
];

export interface EmploymentPropertyDef {
  key: EmploymentProperty;
  label: string;
}

export const EMPLOYMENT_PROPERTY_DEFS: EmploymentPropertyDef[] = [
  { key: "jobTitle", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "grade", label: "Grade" },
  { key: "manager", label: "Reporting manager" },
  { key: "location", label: "Location" },
  { key: "salary", label: "Salary (annual gross)" },
];

export const EMPLOYMENT_PROPERTY_LABELS: Record<EmploymentProperty, string> = Object.fromEntries(
  EMPLOYMENT_PROPERTY_DEFS.map((p) => [p.key, p.label]),
) as Record<EmploymentProperty, string>;

/** The change kinds the writer accepts (the benchmark's Promotion /
 * Transfer doctypes; the kind names the event, the rows carry the diff). */
export type EmploymentChangeKind = "PROMOTION" | "TRANSFER";

export const EMPLOYMENT_CHANGE_KINDS: EmploymentChangeKind[] = ["PROMOTION", "TRANSFER"];

export const EMPLOYMENT_CHANGE_KIND_LABELS: Record<EmploymentChangeKind, string> = {
  PROMOTION: "Promotion",
  TRANSFER: "Transfer",
};

// ---------------------------------------------------------------------------
// The diff planner.
// ---------------------------------------------------------------------------

/** One structured property-history row: the display value before and after. */
export interface PropertyDiffRow {
  property: EmploymentProperty;
  currentValue: string;
  newValue: string;
}

/**
 * Plan the change: given the CURRENT display values and the REQUESTED
 * display values (both already rendered — department labels, manager
 * names, formatted gross), return one row per property whose value
 * actually changed, in registry order. An empty result is the honest
 * "nothing changed" the writer refuses.
 */
export function planEmploymentChange(input: {
  current: Partial<Record<EmploymentProperty, string>>;
  requested: Partial<Record<EmploymentProperty, string>>;
}): PropertyDiffRow[] {
  const rows: PropertyDiffRow[] = [];
  for (const property of EMPLOYMENT_PROPERTIES) {
    const current = input.current[property];
    const requested = input.requested[property];
    if (current === undefined || requested === undefined) continue; // not part of this change
    if (current === requested) continue; // unchanged — recorded nowhere
    rows.push({ property, currentValue: current, newValue: requested });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The salary revision.
// ---------------------------------------------------------------------------

/**
 * The raise: scale every FIXED EARNING component's annual amount by
 * (1 + raisePercent/100), rounded to the whole currency unit the offer
 * math stores. Percent-mode earnings ride their basis at resolve time
 * (PERCENT_OF_BASIC grows with the grown basic; PERCENT_OF_GROSS with the
 * grown gross); deductions, employer contributions and statistical lines
 * ride untouched — a raise is an earnings event, not a recomposition.
 * Returns null when the structure has no FIXED earning to raise (an
 * all-percent earnings side scales nothing — the writer refuses with the
 * friendly error instead of recording a silent no-op).
 */
export function raiseStructure(
  components: OfferComponent[],
  raisePercent: number,
): { components: OfferComponent[]; raisedAny: boolean } {
  const factor = 1 + raisePercent / 100;
  let raisedAny = false;
  const revised = components.map((c) => {
    if (c.kind === "EARNING" && c.mode === "FIXED") {
      raisedAny = true;
      return { ...c, amount: Math.max(0, Math.round(c.amount * factor)) };
    }
    return c; // untouched reference — the unchanged lines stay value-identical
  });
  return { components: revised, raisedAny };
}

/** Annual gross (Σ resolved earnings) of a component set — computeOffer
 * already resolves percent modes; the promotion's "salary" display rides
 * the SAME resolution the payslip math uses (one rule, both callers). */
export function annualGrossOf(components: OfferComponent[]): number {
  return Math.round(computeOffer(components).earnings);
}

// ---------------------------------------------------------------------------
// The retirement projection (EM-B02).
// ---------------------------------------------------------------------------

/**
 * Project the retirement month: birthDate + retirementAge years. Pure
 * calendar math over the ISO date string the profile carries
 * ("yyyy-mm-dd"); returns null when either input is missing (no birthday
 * on file or no workspace age configured → the modal renders no line,
 * the pre-P33 silence). Display-only: nothing gates on the projection.
 */
export function retirementProjection(input: {
  birthDate: string | null;
  retirementAge: number | null;
}): { iso: string; year: number; monthLabel: string } | null {
  if (!input.birthDate || input.retirementAge == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.birthDate);
  if (!m) return null;
  const year = Number(m[1]) + input.retirementAge;
  const month = Number(m[2]);
  const monthLabel = new Date(Date.UTC(2020, month - 1, 1)).toLocaleString("en-NZ", {
    month: "short",
    timeZone: "UTC",
  });
  return { iso: `${year}-${m[2]}-${m[3]}`, year, monthLabel };
}

// ---------------------------------------------------------------------------
// Display helpers the writer and the modal share (same strings, both
// callers — the history rows, the modal preview and the audit line can
// never drift).
// ---------------------------------------------------------------------------

/** "$95,000" — whole units, en-NZ grouping (the offer surfaces' own
 * convention). */
export function formatAnnualGross(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-NZ")}`;
}
