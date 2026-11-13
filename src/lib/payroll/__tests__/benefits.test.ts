import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P5 (PR-15–18, PR-B04, F3.2) — the flexible-benefits kernel tests.
// ---------------------------------------------------------------------------

import { planBenefitElection, accrualAmount, benefitBalance, planBenefitClaim, benefitPayoutLabel } from "@/lib/payroll/benefits";

describe("planBenefitElection (the cap rule)", () => {
  it("accepts an election within the cap, replacing the same component's amount", () => {
    const plan = planBenefitElection({
      maxBenefits: 2_000, currentAnnualTotal: 1_200, currentComponentAnnual: 500, annualAmount: 1_000,
    });
    // new total = 1200 − 500 + 1000 = 1700 ≤ 2000.
    expect(plan).toEqual({ ok: true, annualAmount: 1_000 });
  });

  it("refuses past the cap", () => {
    const plan = planBenefitElection({
      maxBenefits: 2_000, currentAnnualTotal: 1_200, currentComponentAnnual: 500, annualAmount: 1_800,
    });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("$2,000");
  });

  it("zero cap = uncapped (the pre-P5 world elects freely)", () => {
    const plan = planBenefitElection({
      maxBenefits: 0, currentAnnualTotal: 0, currentComponentAnnual: 0, annualAmount: 99_999,
    });
    expect(plan).toEqual({ ok: true, annualAmount: 99_999 });
  });

  it("refuses non-positive amounts", () => {
    expect(planBenefitElection({ maxBenefits: 0, currentAnnualTotal: 0, currentComponentAnnual: 0, annualAmount: 0 }).ok).toBe(false);
    expect(planBenefitElection({ maxBenefits: 0, currentAnnualTotal: 0, currentComponentAnnual: 0, annualAmount: -5 }).ok).toBe(false);
  });
});

describe("accrualAmount (÷12, paid-days-scaled)", () => {
  it("full month accrues annual ÷ 12", () => {
    expect(accrualAmount({ annualAmount: 1_200, paidDays: 22, workingDays: 22 })).toBe(100);
  });

  it("a mid-month joiner accrues the paid fraction (S5 discipline)", () => {
    expect(accrualAmount({ annualAmount: 1_200, paidDays: 11, workingDays: 22 })).toBe(50);
  });

  it("null paidDays (pre-S5 rows) accrues the full month", () => {
    expect(accrualAmount({ annualAmount: 1_200, paidDays: null, workingDays: 22 })).toBe(100);
  });

  it("guards degenerate inputs", () => {
    expect(accrualAmount({ annualAmount: -5, paidDays: 22, workingDays: 22 })).toBe(0);
    expect(accrualAmount({ annualAmount: 1_200, paidDays: 22, workingDays: 0 })).toBe(100);
  });
});

describe("benefitBalance / planBenefitClaim", () => {
  it("balance = Σ ledger deltas (accruals minus claims)", () => {
    expect(benefitBalance([{ delta: 100 }, { delta: 50 }, { delta: -40 }])).toBe(110);
  });

  it("a claim within the accrued balance is lawful", () => {
    expect(planBenefitClaim({ balance: 110, amount: 60 })).toEqual({ ok: true, amount: 60 });
  });

  it("a claim past the balance is refused — claims cannot outrun locked accruals", () => {
    const plan = planBenefitClaim({ balance: 110, amount: 111 });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("$110");
  });

  it("refuses non-positive claims", () => {
    expect(planBenefitClaim({ balance: 110, amount: 0 }).ok).toBe(false);
  });
});

describe("benefitPayoutLabel", () => {
  it("labels from the code or the human label", () => {
    expect(benefitPayoutLabel("HEALTH", "Health insurance")).toBe("Benefit claim — Health insurance");
    expect(benefitPayoutLabel("HEALTH", "")).toBe("Benefit claim — HEALTH");
  });
});
