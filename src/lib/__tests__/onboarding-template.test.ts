import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.10 (F-R8) — the canonical onboarding templates + the fallback rule
// (lib/onboarding-template.ts). Pins the constants so the empty-table
// fallback can never drift from the seeded OnboardingTemplateTask rows.
//
// P35 (EM-12/EM-B06/EM-11) — template depth: the user-XOR-role assignee
// resolution, the required flag and the DERIVED completion status.
// ---------------------------------------------------------------------------

import {
  DEFAULT_ONBOARDING_TEMPLATE,
  DEFAULT_SEPARATION_TEMPLATE,
  templateForKind,
  resolveTemplateAssignee,
  checklistCompletion,
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

  it("P35 — the required flags: contract/SSO onboarding, handover/access/FnF separation", () => {
    expect(DEFAULT_ONBOARDING_TEMPLATE.filter((t) => t.isRequired).map((t) => t.title)).toEqual([
      "Sign the employment contract",
      "Set up accounts and SSO access",
    ]);
    expect(DEFAULT_SEPARATION_TEMPLATE.filter((t) => t.isRequired).map((t) => t.title)).toEqual([
      "Hand over ongoing work and documents",
      "Revoke accounts, SSO and tool access",
      "Settle the full-and-final statement",
    ]);
  });

  it("P35 — access revocation is the role-scoped default (the HR role)", () => {
    const scoped = DEFAULT_SEPARATION_TEMPLATE.find((t) => t.assigneeRole !== "");
    expect(scoped?.assigneeRole).toBe("HR");
    expect(scoped?.title).toBe("Revoke accounts, SSO and tool access");
    // No default pins a user, and the XOR holds on every default row.
    for (const t of [...DEFAULT_ONBOARDING_TEMPLATE, ...DEFAULT_SEPARATION_TEMPLATE]) {
      expect(t.assigneeUserId).toBeNull();
      expect(Boolean(t.assigneeUserId) && Boolean(t.assigneeRole)).toBe(false);
    }
  });
});

describe("templateForKind — the fallback rule", () => {
  const row = (r: Partial<import("@/lib/onboarding-template").OnboardingTemplateTaskRow>) => ({
    id: "x", kind: "ONBOARDING", title: "T", dueOffsetDays: 3, assignSelf: false,
    assigneeUserId: null, assigneeRole: "", isRequired: false, isActive: true, sortOrder: 0,
    ...r,
  });

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
      row({ id: "a", kind: "SEPARATION", title: "Exit-only", assignSelf: true, sortOrder: 0 }),
      row({ id: "b", kind: "ONBOARDING", title: "Second", assignSelf: true, sortOrder: 20 }),
      row({ id: "c", kind: "ONBOARDING", title: "First", assignSelf: false, sortOrder: 10 }),
      row({ id: "d", kind: "ONBOARDING", title: "Off", assignSelf: true, isActive: false, sortOrder: 5 }),
    ];
    expect(templateForKind("ONBOARDING", rows).map((t) => t.title)).toEqual(["First", "Second"]);
    expect(templateForKind("SEPARATION", rows).map((t) => t.title)).toEqual(["Exit-only"]);
  });

  it("P35 — the user/role/required axes ride the mapped rows", () => {
    const rows = [
      row({ id: "u", title: "Pinned", assigneeUserId: "user-9", isRequired: true, sortOrder: 1 }),
      row({ id: "r", title: "Role-scoped", assigneeRole: "HR", sortOrder: 2 }),
    ];
    const out = templateForKind("ONBOARDING", rows);
    expect(out[0]).toMatchObject({ title: "Pinned", assigneeUserId: "user-9", assigneeRole: "", isRequired: true });
    expect(out[1]).toMatchObject({ title: "Role-scoped", assigneeUserId: null, assigneeRole: "HR", isRequired: false });
  });
});

describe("resolveTemplateAssignee — the user XOR role precedence (P35/EM-B06)", () => {
  const base = { assigneeUserId: null as string | null, assigneeRole: "", assignSelf: false };

  it("a pinned user wins and lands as the single assignee", () => {
    expect(resolveTemplateAssignee({ ...base, assigneeUserId: "u-7" }, "hire-1")).toEqual({
      assigneeId: "u-7", assigneeRole: "",
    });
  });

  it("a role key keeps the task role-scoped (assigneeId stays null)", () => {
    expect(resolveTemplateAssignee({ ...base, assigneeRole: "HR" }, "hire-1")).toEqual({
      assigneeId: null, assigneeRole: "HR",
    });
  });

  it("a user beats a role when both smuggle in (defense in depth for the XOR)", () => {
    expect(resolveTemplateAssignee({ assigneeUserId: "u-7", assigneeRole: "HR", assignSelf: true }, "hire-1")).toEqual({
      assigneeId: "u-7", assigneeRole: "",
    });
  });

  it("neither set: assignSelf → the hire; else the manager default (null)", () => {
    expect(resolveTemplateAssignee({ ...base, assignSelf: true }, "hire-1")).toEqual({
      assigneeId: "hire-1", assigneeRole: "",
    });
    expect(resolveTemplateAssignee(base, "hire-1")).toEqual({ assigneeId: null, assigneeRole: "" });
  });
});

describe("checklistCompletion — the DERIVED boarding status (P35/EM-11)", () => {
  it("an empty checklist is NOT_STARTED at 0%", () => {
    expect(checklistCompletion([])).toEqual({ done: 0, total: 0, percent: 0, status: "NOT_STARTED", requiredOpen: 0 });
  });

  it("nothing done = NOT_STARTED; some done = IN_PROGRESS; all done = COMPLETE", () => {
    expect(checklistCompletion([{ done: false }, { done: false }]).status).toBe("NOT_STARTED");
    const mid = checklistCompletion([{ done: true }, { done: false }]);
    expect(mid).toMatchObject({ done: 1, total: 2, percent: 50, status: "IN_PROGRESS" });
    expect(checklistCompletion([{ done: true }, { done: true }]).status).toBe("COMPLETE");
  });

  it("percent rounds (1/3 → 33, 2/3 → 67) and counts the open required subset", () => {
    const out = checklistCompletion([
      { done: true }, { done: false, isRequired: true }, { done: false, isRequired: true },
    ]);
    expect(out.percent).toBe(33);
    expect(out.requiredOpen).toBe(2);
    expect(checklistCompletion([{ done: true }, { done: true }, { done: false }]).percent).toBe(67);
  });

  it("requiredOpen ignores done required tasks", () => {
    expect(checklistCompletion([{ done: true, isRequired: true }, { done: false, isRequired: true }]).requiredOpen).toBe(1);
  });
});
