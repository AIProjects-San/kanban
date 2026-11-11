import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01) — the structured property-history kernel: the diff
// planner (one row per CHANGED property), the shape-preserving raise, the
// gross resolution, and the retirement projection (EM-B02's display math).
// Pure and DB-free; the server-action tests pin the writer's gates.
// ---------------------------------------------------------------------------

import {
  planEmploymentChange,
  raiseStructure,
  annualGrossOf,
  retirementProjection,
  formatAnnualGross,
  EMPLOYMENT_PROPERTIES,
} from "@/lib/employment-change";
import type { OfferComponent } from "@/lib/offer-math";

function comp(patch: Partial<OfferComponent>): OfferComponent {
  return {
    key: "basic",
    label: "Basic Salary",
    kind: "EARNING",
    mode: "FIXED",
    amount: 96_000,
    ...patch,
  };
}

describe("P33 — planEmploymentChange (the structured diff)", () => {
  it("returns ONE row per property whose value actually changed, in registry order", () => {
    const rows = planEmploymentChange({
      current: { jobTitle: "UX Researcher", department: "Design", manager: "Ada", salary: "$84,000" },
      requested: { jobTitle: "Senior UX Researcher", department: "Design", manager: "Ingrid", salary: "$91,800" },
    });
    // department unchanged → no row; the three changed properties record.
    expect(rows.map((r) => r.property)).toEqual(["jobTitle", "manager", "salary"]);
    expect(rows[0]).toEqual({ property: "jobTitle", currentValue: "UX Researcher", newValue: "Senior UX Researcher" });
    expect(rows[1]).toEqual({ property: "manager", currentValue: "Ada", newValue: "Ingrid" });
    expect(rows[2]).toEqual({ property: "salary", currentValue: "$84,000", newValue: "$91,800" });
  });

  it("skips properties absent from the request (not part of the change)", () => {
    const rows = planEmploymentChange({
      current: { jobTitle: "A", manager: "Ada" },
      requested: { jobTitle: "B" },
    });
    expect(rows).toEqual([{ property: "jobTitle", currentValue: "A", newValue: "B" }]);
  });

  it("an all-unchanged change is empty — the writer refuses it as noise", () => {
    const rows = planEmploymentChange({
      current: { jobTitle: "A", department: "Design" },
      requested: { jobTitle: "A", department: "Design" },
    });
    expect(rows).toEqual([]);
  });

  it("the registry covers the promotable properties (grade joined at P34/EM-03)", () => {
    expect(EMPLOYMENT_PROPERTIES).toEqual(["jobTitle", "department", "grade", "manager", "salary"]);
  });

  // P34 (EM-03) — grade is promotable: the diff planner treats it exactly
  // like jobTitle (a display string the writer resolves; "" renders "—").
  it("P34 — a grade move records between department and manager (registry order)", () => {
    const rows = planEmploymentChange({
      current: { jobTitle: "Backend Engineer", department: "Engineering", grade: "L4", manager: "(none)" },
      requested: { jobTitle: "Senior Backend Engineer", department: "Engineering", grade: "L5", manager: "(none)" },
    });
    expect(rows.map((r) => r.property)).toEqual(["jobTitle", "grade"]);
    expect(rows[1]).toEqual({ property: "grade", currentValue: "L4", newValue: "L5" });
  });

  it("P34 — an unchanged grade records nothing (the no-noise rule)", () => {
    const rows = planEmploymentChange({
      current: { grade: "L4" },
      requested: { grade: "L4" },
    });
    expect(rows).toEqual([]);
  });
});

describe("P33 — raiseStructure (the shape-preserving salary revision)", () => {
  const STRUCTURE: OfferComponent[] = [
    comp({ key: "basic", label: "Basic Salary", amount: 96_000 }),
    comp({ key: "housing", label: "Housing Allowance", amount: 12_000 }),
    comp({ key: "overtime-pay", label: "Overtime", kind: "STATISTICAL", amount: 0 }),
    comp({ key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 }),
    comp({ key: "loan", label: "Advance recovery", kind: "DEDUCTION", amount: 2_400 }),
  ];

  it("scales FIXED earnings by the factor, whole-unit rounded; everything else rides untouched", () => {
    const { components, raisedAny } = raiseStructure(STRUCTURE, 8);
    expect(raisedAny).toBe(true);
    // 96,000 × 1.08 = 103,680; 12,000 × 1.08 = 12,960 — both exact.
    expect(components.find((c) => c.key === "basic")?.amount).toBe(103_680);
    expect(components.find((c) => c.key === "housing")?.amount).toBe(12_960);
    // Percent-mode earnings are NOT re-stated (the grown basis resolves at
    // payslip time), deductions and employer lines ride untouched.
    expect(components.find((c) => c.key === "kiwisaver")?.amount).toBe(3);
    expect(components.find((c) => c.key === "loan")?.amount).toBe(2_400);
  });

  it("rounds to whole currency units (the offer-math storage convention)", () => {
    const { components } = raiseStructure([comp({ key: "basic", amount: 78_001 })], 8);
    // 78,001 × 1.08 = 84,241.08 → 84,241
    expect(components[0].amount).toBe(84_241);
  });

  it("an all-percent earnings side raises nothing — raisedAny false (the writer refuses)", () => {
    const allPercent: OfferComponent[] = [
      comp({ key: "bonus", mode: "PERCENT_OF_GROSS", amount: 10 }),
      comp({ key: "loan", kind: "DEDUCTION", amount: 1_000 }),
    ];
    const { components, raisedAny } = raiseStructure(allPercent, 8);
    expect(raisedAny).toBe(false);
    expect(components).toEqual(allPercent);
  });

  it("non-positive results clamp to zero (hostile stored data can't mint negative pay)", () => {
    const { components } = raiseStructure([comp({ key: "basic", amount: -10 })], 8);
    expect(components[0].amount).toBe(0);
  });
});

describe("P33 — annualGrossOf (the salary row's display resolution)", () => {
  it("sums resolved earnings — FIXED plus percent-of-basic riding the basic", () => {
    const gross = annualGrossOf([
      comp({ key: "basic", amount: 84_000 }),
      comp({ key: "transport", label: "Transport", amount: 2_400 }),
      comp({ key: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 }),
    ]);
    // Employer contributions are NOT employee earnings: 84,000 + 2,400.
    expect(gross).toBe(86_400);
  });

  it("rounds to the whole unit (percent modes resolve fractionally)", () => {
    const gross = annualGrossOf([
      comp({ key: "basic", amount: 83_333 }),
      comp({ key: "bonus", mode: "PERCENT_OF_BASIC", amount: 7 }),
    ]);
    // 83,333 + 5,833.31 = 89,166.31 → 89,166
    expect(gross).toBe(89_166);
  });
});

describe("P33 — retirementProjection (EM-B02's display math)", () => {
  it("projects birthDate + retirementAge to the retirement month", () => {
    const p = retirementProjection({ birthDate: "1991-08-30", retirementAge: 65 });
    expect(p).toEqual({ iso: "2056-08-30", year: 2056, monthLabel: "Aug" });
  });

  it("renders no projection without a birthday or without a configured age", () => {
    expect(retirementProjection({ birthDate: null, retirementAge: 65 })).toBeNull();
    expect(retirementProjection({ birthDate: "1991-08-30", retirementAge: null })).toBeNull();
    expect(retirementProjection({ birthDate: null, retirementAge: null })).toBeNull();
  });

  it("rejects malformed dates honestly (never a fabricated projection)", () => {
    expect(retirementProjection({ birthDate: "not-a-date", retirementAge: 65 })).toBeNull();
    expect(retirementProjection({ birthDate: "1991-8-30", retirementAge: 65 })).toBeNull();
  });

  it("crosses century boundaries (a 1999 birth at 65 retires 2064)", () => {
    expect(retirementProjection({ birthDate: "1999-12-31", retirementAge: 65 })?.year).toBe(2064);
  });
});

describe("P33 — formatAnnualGross (the shared display strings)", () => {
  it("renders whole units with en-NZ grouping — the same string the history row, the audit line and the modal preview read", () => {
    expect(formatAnnualGross(91800)).toBe("$91,800");
    expect(formatAnnualGross(86_400)).toBe("$86,400");
    expect(formatAnnualGross(1_234_567)).toBe("$1,234,567");
  });
});

// Compile-time guard: the kernel must not depend on the DB (the pure-module
// contract every caller rides).
it("the kernel module has no server-only imports (pure by construction)", async () => {
  const mod = await import("@/lib/employment-change");
  expect(Object.keys(mod).length).toBeGreaterThan(0);
  expect((mod as unknown as { db?: unknown }).db).toBeUndefined();
});
