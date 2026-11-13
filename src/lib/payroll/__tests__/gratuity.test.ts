import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — the gratuity slab engine kernel tests.
// Slab walk, service-years math, earnings averaging, validation, and the
// note's honesty rules (uncovered years named, disclaimer always present).
// ---------------------------------------------------------------------------

import {
  computeGratuity,
  finalAverageEarnings,
  gratuityNote,
  serviceLengthBetween,
  validateGratuityRuleInput,
  GRATUITY_DISCLAIMER,
} from "@/lib/payroll/gratuity";

describe("validateGratuityRuleInput", () => {
  it("accepts a sorted, non-overlapping rule and returns it sorted", () => {
    const plan = validateGratuityRuleInput({
      enabled: true,
      averagingMonths: 3,
      slabs: [
        { fromYears: 5, toYears: null, fraction: 0.5 },
        { fromYears: 1, toYears: 4, fraction: 0.25 },
      ],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.slabs.map((s) => s.fromYears)).toEqual([1, 5]);
  });

  it("refuses inverted bands (toYears must exceed fromYears)", () => {
    const plan = validateGratuityRuleInput({
      enabled: true, averagingMonths: 3,
      slabs: [{ fromYears: 5, toYears: 3, fraction: 0.5 }],
    });
    expect(plan).toEqual({ ok: false, reason: expect.stringContaining("greater than") });
  });

  it("refuses overlapping slabs", () => {
    const plan = validateGratuityRuleInput({
      enabled: true, averagingMonths: 3,
      slabs: [
        { fromYears: 1, toYears: 5, fraction: 0.25 },
        { fromYears: 5, toYears: null, fraction: 0.5 },
      ],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("overlap");
  });

  it("allows gaps between slabs (an uncovered band is a rule choice)", () => {
    const plan = validateGratuityRuleInput({
      enabled: true, averagingMonths: 3,
      slabs: [
        { fromYears: 1, toYears: 2, fraction: 0.25 },
        { fromYears: 5, toYears: null, fraction: 0.5 },
      ],
    });
    expect(plan.ok).toBe(true);
  });

  it("bounds the averaging window to 1–12 months", () => {
    for (const averagingMonths of [0, 13, 2.5]) {
      expect(
        validateGratuityRuleInput({ enabled: true, averagingMonths, slabs: [] }).ok,
      ).toBe(false);
    }
    expect(validateGratuityRuleInput({
      enabled: true, averagingMonths: 12, slabs: [],
    }).ok).toBe(true);
  });

  it("bounds fractions to [0, 12] months per year", () => {
    expect(validateGratuityRuleInput({
      enabled: true, averagingMonths: 3,
      slabs: [{ fromYears: 1, toYears: null, fraction: -0.1 }],
    }).ok).toBe(false);
    expect(validateGratuityRuleInput({
      enabled: true, averagingMonths: 3,
      slabs: [{ fromYears: 1, toYears: null, fraction: 13 }],
    }).ok).toBe(false);
  });
});

describe("serviceLengthBetween", () => {
  it("counts whole months, day-of-month aware", () => {
    expect(serviceLengthBetween("2024-02-05", "2026-11-04")).toEqual({
      completedYears: 2, extraMonths: 8, totalMonths: 32,
    });
    expect(serviceLengthBetween("2024-02-05", "2026-11-05")).toEqual({
      completedYears: 2, extraMonths: 9, totalMonths: 33,
    });
  });

  it("handles same-day and month-end arithmetic without off-by-ones", () => {
    expect(serviceLengthBetween("2025-01-31", "2025-02-28").totalMonths).toBe(0); // Feb never reaches day 31
    expect(serviceLengthBetween("2025-01-31", "2025-03-01").totalMonths).toBe(1);
    expect(serviceLengthBetween("2025-06-15", "2025-06-15")).toEqual({
      completedYears: 0, extraMonths: 0, totalMonths: 0,
    });
  });

  it("reversed or invalid dates yield zero service", () => {
    expect(serviceLengthBetween("2026-01-01", "2024-01-01").totalMonths).toBe(0);
    expect(serviceLengthBetween("nonsense", "2026-01-01").totalMonths).toBe(0);
  });
});

describe("finalAverageEarnings", () => {
  it("averages the samples and rounds once", () => {
    expect(finalAverageEarnings([6_000, 6_050, 5_950])).toBe(6_000);
    expect(finalAverageEarnings([5_000, 5_050])).toBe(5_025);
  });

  it("drops non-positive and non-finite samples; null when nothing usable", () => {
    expect(finalAverageEarnings([0, -10, NaN, 5_000])).toBe(5_000);
    expect(finalAverageEarnings([])).toBeNull();
    expect(finalAverageEarnings([0, -5])).toBeNull();
  });
});

describe("computeGratuity (the slab walk)", () => {
  const SLABS = [
    { fromYears: 1, toYears: 2, fraction: 0.25 },
    { fromYears: 3, toYears: 4, fraction: 0.5 },
    { fromYears: 5, toYears: null, fraction: 1 },
  ];

  it("walks each completed year through its band", () => {
    // 6 completed years: 2×0.25 + 2×0.5 + 2×1 = 3.5 months of earnings.
    const r = computeGratuity({
      service: { completedYears: 6, extraMonths: 0, totalMonths: 72 },
      averageMonthlyEarnings: 10_000,
      slabs: SLABS,
    });
    expect(r.amount).toBe(35_000);
    expect(r.breakdown).toHaveLength(6);
    expect(r.breakdown[0]).toEqual({ year: 1, fraction: 0.25, amount: 2_500 });
    expect(r.breakdown[5]).toEqual({ year: 6, fraction: 1, amount: 10_000 });
    expect(r.uncoveredYears).toEqual([]);
  });

  it("the incomplete final year pays nothing (completed years only)", () => {
    const r = computeGratuity({
      service: { completedYears: 2, extraMonths: 11, totalMonths: 35 },
      averageMonthlyEarnings: 10_000,
      slabs: SLABS,
    });
    expect(r.amount).toBe(5_000); // 2 × 0.25 — the 11 extra months add 0
  });

  it("names uncovered years instead of silently paying zero", () => {
    const r = computeGratuity({
      service: { completedYears: 6, extraMonths: 0, totalMonths: 72 },
      averageMonthlyEarnings: 10_000,
      slabs: [{ fromYears: 5, toYears: null, fraction: 1 }], // years 1–4 uncovered
    });
    expect(r.amount).toBe(20_000);
    expect(r.uncoveredYears).toEqual([1, 2, 3, 4]);
  });

  it("a fraction-0 slab is a deliberate zero, not a gap", () => {
    const r = computeGratuity({
      service: { completedYears: 4, extraMonths: 0, totalMonths: 48 },
      averageMonthlyEarnings: 10_000,
      slabs: [
        { fromYears: 1, toYears: 4, fraction: 0 },
        { fromYears: 5, toYears: null, fraction: 1 },
      ],
    });
    expect(r.amount).toBe(0);
    expect(r.uncoveredYears).toEqual([]); // covered, deliberately zero
    expect(r.breakdown).toHaveLength(0);
  });

  it("rounds once, on the total", () => {
    const r = computeGratuity({
      service: { completedYears: 3, extraMonths: 0, totalMonths: 36 },
      averageMonthlyEarnings: 6_666.67, // 2 × 0.25 + 1 × 0.5 = 1 month → 6666.67
      slabs: SLABS,
    });
    expect(r.amount).toBe(6_666.67);
  });

  it("zero completed years pays nothing regardless of slabs", () => {
    const r = computeGratuity({
      service: { completedYears: 0, extraMonths: 11, totalMonths: 11 },
      averageMonthlyEarnings: 10_000,
      slabs: SLABS,
    });
    expect(r.amount).toBe(0);
    expect(r.breakdown).toEqual([]);
  });
});

describe("gratuityNote", () => {
  it("shows its own work: years, basis, gaps — then the disclaimer", () => {
    const note = gratuityNote({
      service: { completedYears: 6, extraMonths: 2, totalMonths: 74 },
      averagingMonths: 3,
      averageMonthlyEarnings: 10_000,
      earningsBasis: "PAYSLIPS",
      computation: { amount: 35_000, breakdown: [], uncoveredYears: [3] },
    });
    expect(note).toContain("6 completed years 2 months of service");
    expect(note).toContain("$10,000.00");
    expect(note).toContain("last 3 payslip months");
    expect(note).toContain("year 3 covered by no slab");
    expect(note.endsWith(GRATUITY_DISCLAIMER)).toBe(true);
  });

  it("names the structure fallback basis", () => {
    const note = gratuityNote({
      service: { completedYears: 1, extraMonths: 0, totalMonths: 12 },
      averagingMonths: 3,
      averageMonthlyEarnings: 6_000,
      earningsBasis: "STRUCTURE",
      computation: { amount: 1_500, breakdown: [{ year: 1, fraction: 0.25, amount: 1_500 }], uncoveredYears: [] },
    });
    expect(note).toContain("active structure's monthly gross");
    expect(note).toContain(GRATUITY_DISCLAIMER);
  });
});
