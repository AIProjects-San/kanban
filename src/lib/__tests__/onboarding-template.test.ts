import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.10 (F-R8) — the canonical onboarding templates + the fallback rule
// (lib/onboarding-template.ts). Pins the constants so the empty-table
// fallback can never drift from the seeded OnboardingTemplateTask rows.
// ---------------------------------------------------------------------------

import {
  DEFAULT_ONBOARDING_TEMPLATE,
  DEFAULT_SEPARATION_TEMPLATE,
  templateForKind,
} from "@/lib/onboarding-template";

describe("the canonical constants", () => {
  it("the ONBOARDING template is the historical 5 tasks (self flags intact)", () => {
    expect(DEFAULT_ONBOARDING_TEMPLATE.map((t) => [t.title, t.dueOffsetDays, t.assignSelf])).toEqual([
      ["Sign the employment contract", 1, false],
      ["Set up accounts and SSO access", 2, false],
      ["Meet your manager for the 1:1 kick-off", 3, false],
      ["Complete the workspace tour", 5, true],
      ["First small task shipped with a mentor", 14, true],
    ]);
  });

  it("the SEPARATION template is F2.1's exit list (5 tasks)", () => {
    expect(DEFAULT_SEPARATION_TEMPLATE).toHaveLength(5);
    expect(DEFAULT_SEPARATION_TEMPLATE.map((t) => t.title)).toContain("Settle the full-and-final statement");
  });
});

describe("templateForKind — the fallback rule", () => {
  it("an empty table falls back to the constants (fresh install is never template-less)", () => {
    expect(templateForKind("ONBOARDING", [])).toEqual(DEFAULT_ONBOARDING_TEMPLATE);
    expect(templateForKind("SEPARATION", [])).toEqual(DEFAULT_SEPARATION_TEMPLATE);
  });

  it("all rows deactivated also falls back (the active list is what matters)", () => {
    const rows = DEFAULT_ONBOARDING_TEMPLATE.map((t, i) => ({
      ...t, id: `tt-${i}`, isActive: false, sortOrder: i,
    }));
    expect(templateForKind("ONBOARDING", rows)).toEqual(DEFAULT_ONBOARDING_TEMPLATE);
  });

  it("active rows win, filtered by kind, ordered by sortOrder", () => {
    const rows = [
      { id: "a", kind: "SEPARATION", title: "Exit-only", dueOffsetDays: 3, assignSelf: true, isActive: true, sortOrder: 0 },
      { id: "b", kind: "ONBOARDING", title: "Second", dueOffsetDays: 2, assignSelf: true, isActive: true, sortOrder: 20 },
      { id: "c", kind: "ONBOARDING", title: "First", dueOffsetDays: 1, assignSelf: false, isActive: true, sortOrder: 10 },
      { id: "d", kind: "ONBOARDING", title: "Off", dueOffsetDays: 9, assignSelf: true, isActive: false, sortOrder: 5 },
    ];
    expect(templateForKind("ONBOARDING", rows).map((t) => t.title)).toEqual(["First", "Second"]);
    expect(templateForKind("SEPARATION", rows).map((t) => t.title)).toEqual(["Exit-only"]);
  });
});
