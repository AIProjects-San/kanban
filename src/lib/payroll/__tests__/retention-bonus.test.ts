import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P6 (PR-20/PR-23, PR-T01) — the retention-bonus kernel tests.
// ---------------------------------------------------------------------------

import { planRetentionBonus, periodPlusMonths, retentionBonusLabel } from "@/lib/payroll/retention-bonus";

describe("planRetentionBonus", () => {
  it("splits evenly when the total divides cleanly", () => {
    expect(planRetentionBonus({ totalAmount: 3_000, installments: 3 })).toEqual({
      ok: true, perInstallment: 1_000, lastInstallment: 1_000,
    });
  });

  it("the LAST installment absorbs the rounding remainder (Σ == total exactly)", () => {
    // 1000 / 3 = 333.33 → 2 × 333.33 = 666.66 → last = 333.34.
    const plan = planRetentionBonus({ totalAmount: 1_000, installments: 3 });
    expect(plan).toEqual({ ok: true, perInstallment: 333.33, lastInstallment: 333.34 });
    if (plan.ok) expect(plan.perInstallment * 2 + plan.lastInstallment).toBe(1_000);
  });

  it("single installment pays the whole total", () => {
    expect(planRetentionBonus({ totalAmount: 750.55, installments: 1 })).toEqual({
      ok: true, perInstallment: 750.55, lastInstallment: 750.55,
    });
  });

  it("refuses non-positive totals and out-of-range installments", () => {
    expect(planRetentionBonus({ totalAmount: 0, installments: 3 }).ok).toBe(false);
    expect(planRetentionBonus({ totalAmount: -5, installments: 3 }).ok).toBe(false);
    expect(planRetentionBonus({ totalAmount: 100, installments: 0 }).ok).toBe(false);
    expect(planRetentionBonus({ totalAmount: 100, installments: 13 }).ok).toBe(false);
    expect(planRetentionBonus({ totalAmount: 100, installments: 1.5 }).ok).toBe(false);
  });

  it("refuses totals too small to split", () => {
    expect(planRetentionBonus({ totalAmount: 0.02, installments: 12 }).ok).toBe(false);
  });
});

describe("periodPlusMonths", () => {
  it("walks months with year rollover", () => {
    expect(periodPlusMonths("2026-11", 0)).toBe("2026-11");
    expect(periodPlusMonths("2026-11", 1)).toBe("2026-12");
    expect(periodPlusMonths("2026-11", 2)).toBe("2027-01");
    expect(periodPlusMonths("2026-12", 1)).toBe("2027-01");
    expect(periodPlusMonths("2027-01", 11)).toBe("2027-12");
  });

  it("guards malformed periods by returning them unchanged", () => {
    expect(periodPlusMonths("nope", 3)).toBe("nope");
  });
});

describe("retentionBonusLabel", () => {
  it("names the employee", () => {
    expect(retentionBonusLabel("Diego Fernández")).toBe("Retention bonus — Diego Fernández");
  });
});
