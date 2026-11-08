// ---------------------------------------------------------------------------
// F2.10 — the canonical onboarding templates (defect F-R8).
//
// The SINGLE source of truth for the default task lists. Before F2.10 this
// list existed as THREE copies in code that had already drifted:
//   1. hr-onboarding.ts DEFAULT_TEMPLATE (the original),
//   2. an inline copy inside markJoined (manager tasks never auto-assigned),
//   3. a client copy in joiner-handout.tsx (DAY_ONE_TASKS).
// Now every instantiator reads the OnboardingTemplateTask table, whose
// EMPTY-table fallback is exactly these constants — a fresh install is
// never template-less, and the constants are pinned by unit tests so the
// fallback can never drift from the seeded rows.
//
// assignSelf: true = the hire (or exiting employee) ticks it themself;
// false = the hire's manager owns it (HR picks it up when no manager is
// set) — the auto-assignment discipline hr-onboarding's createChecklist
// has always applied, now shared by markJoined.
// ---------------------------------------------------------------------------

export type OnboardingTemplateKind = "ONBOARDING" | "SEPARATION";

export interface OnboardingTemplateTaskRow {
  id: string;
  kind: string;
  title: string;
  dueOffsetDays: number;
  assignSelf: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** The canonical ONBOARDING template (a new hire's first two weeks). */
export const DEFAULT_ONBOARDING_TEMPLATE: Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[] = [
  { title: "Sign the employment contract", dueOffsetDays: 1, assignSelf: false, kind: "ONBOARDING" },
  { title: "Set up accounts and SSO access", dueOffsetDays: 2, assignSelf: false, kind: "ONBOARDING" },
  { title: "Meet your manager for the 1:1 kick-off", dueOffsetDays: 3, assignSelf: false, kind: "ONBOARDING" },
  { title: "Complete the workspace tour", dueOffsetDays: 5, assignSelf: true, kind: "ONBOARDING" },
  { title: "First small task shipped with a mentor", dueOffsetDays: 14, assignSelf: true, kind: "ONBOARDING" },
];

/** F2.1 — the canonical SEPARATION template (the exit checklist), now also
 * table-driven with the same fallback discipline. */
export const DEFAULT_SEPARATION_TEMPLATE: Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[] = [
  { title: "Hand over ongoing work and documents", dueOffsetDays: 3, assignSelf: true, kind: "SEPARATION" },
  { title: "Return laptop and access devices", dueOffsetDays: 5, assignSelf: true, kind: "SEPARATION" },
  { title: "Revoke accounts, SSO and tool access", dueOffsetDays: 5, assignSelf: false, kind: "SEPARATION" },
  { title: "Hold the exit interview", dueOffsetDays: 7, assignSelf: false, kind: "SEPARATION" },
  { title: "Settle the full-and-final statement", dueOffsetDays: 10, assignSelf: false, kind: "SEPARATION" },
];

/** The template rows to instantiate for a kind: the table's ACTIVE rows in
 * sortOrder order, or the canonical constants when the table has none for
 * that kind (fresh install / everything deactivated). One code path for
 * createChecklist AND markJoined — the F-R8 unification. */
export function templateForKind(
  kind: OnboardingTemplateKind | string,
  rows: OnboardingTemplateTaskRow[],
): Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[] {
  const active = rows
    .filter((r) => r.kind === kind && r.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      kind: r.kind,
      title: r.title,
      dueOffsetDays: r.dueOffsetDays,
      assignSelf: r.assignSelf,
    }));
  if (active.length > 0) return active;
  return kind === "SEPARATION" ? DEFAULT_SEPARATION_TEMPLATE : DEFAULT_ONBOARDING_TEMPLATE;
}
