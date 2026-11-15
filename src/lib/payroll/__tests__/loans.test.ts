import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G3 — the loan kernel tests: the amortization invariants (zero interest,
// reducing balance, rounding remainder, end-of-month clamping), the status
// graph, the due-in-period predicate, the settlement plan, and the
// validation twin. The action surface (lifecycle, adapter rows, the
// settlement writer) is covered in
// src/server-actions/__tests__/loans.test.ts.
// ---------------------------------------------------------------------------

import {
  amortizeLoan,
  canTransitionLoan,
  installmentsDueInPeriod,
  isCancelableLoan,
  isValidLoanInput,
  loanSummary,
  schedulePlanIsExact,
  settlementPlan,
  LOAN_TRANSITIONS,
  fnfLoanReceivable,
} from "../loans";

function sum(nums: number[]): number {
  return Math.round(nums.reduce((s, n) => s + n, 0) * 100) / 100;
}

describe("amortizeLoan — zero interest (equal principal portions)", () => {
  it("splits the principal into equal installments with zero interest", () => {
    const rows = amortizeLoan({ principal: 12_000, annualRate: 0, termMonths: 12, startDay: "2027-01-15" });
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      expect(r.principalPortion).toBe(1_000);
      expect(r.interestPortion).toBe(0);
      expect(r.totalAmount).toBe(1_000);
    }
    expect(schedulePlanIsExact(rows, 12_000)).toBe(true);
  });

  it("the LAST installment absorbs the rounding remainder so the plan sums exactly", () => {
    const rows = amortizeLoan({ principal: 1_000, annualRate: 0, termMonths: 3, startDay: "2027-01-01" });
    expect(rows).toHaveLength(3);
    // 1000 / 3 = 333.33 x2 + 333.34 — never a stray cent.
    expect(rows[0].principalPortion).toBe(333.33);
    expect(rows[1].principalPortion).toBe(333.33);
    expect(rows[2].principalPortion).toBe(333.34);
    expect(sum(rows.map((r) => r.principalPortion))).toBe(1_000);
    expect(rows[2].balanceAfter).toBe(0);
  });
});

describe("amortizeLoan — reducing balance (the annuity)", () => {
  it("interest declines and principal rises as the balance reduces", () => {
    const rows = amortizeLoan({ principal: 10_000, annualRate: 0.12, termMonths: 12, startDay: "2027-01-01" });
    expect(rows).toHaveLength(12);
    // The interest series is strictly decreasing (the balance shrinks).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].interestPortion).toBeLessThan(rows[i - 1].interestPortion);
    }
    // The principal series is strictly increasing.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].principalPortion).toBeGreaterThan(rows[i - 1].principalPortion);
    }
    // First month's interest is the monthly rate on the full principal.
    expect(rows[0].interestPortion).toBe(100); // 10,000 * 0.01
    expect(schedulePlanIsExact(rows, 10_000)).toBe(true);
  });

  it("the total paid is principal + total interest (cents exact)", () => {
    const rows = amortizeLoan({ principal: 5_000, annualRate: 0.08, termMonths: 6, startDay: "2027-03-01" });
    const totalPaid = sum(rows.map((r) => r.totalAmount));
    const totalPrincipal = sum(rows.map((r) => r.principalPortion));
    const totalInterest = sum(rows.map((r) => r.interestPortion));
    expect(totalPrincipal).toBe(5_000);
    expect(totalPaid).toBe(Math.round((totalPrincipal + totalInterest) * 100) / 100);
    // Roughly level payments (the annuity shape): every EMI within ±0.05 of the mean.
    const emi = totalPaid / rows.length;
    for (const r of rows) {
      expect(Math.abs(r.totalAmount - emi)).toBeLessThanOrEqual(0.05);
    }
  });

  it("the final row clears the balance to exactly 0", () => {
    const rows = amortizeLoan({ principal: 7_777.77, annualRate: 0.065, termMonths: 9, startDay: "2027-01-31" });
    expect(rows[rows.length - 1].balanceAfter).toBe(0);
    expect(schedulePlanIsExact(rows, 7_777.77)).toBe(true);
  });
});

describe("amortizeLoan — due dates", () => {
  it("installment 1 is due exactly one month after the start", () => {
    const rows = amortizeLoan({ principal: 1_000, annualRate: 0, termMonths: 2, startDay: "2027-01-15" });
    expect(rows[0].dueDay).toBe("2027-02-15");
    expect(rows[1].dueDay).toBe("2027-03-15");
    expect(rows[0].duePeriod).toBe("2027-02");
  });

  it("end-of-month start dates clamp (Jan 31 + 1 → Feb 28)", () => {
    const rows = amortizeLoan({ principal: 1_000, annualRate: 0, termMonths: 2, startDay: "2027-01-31" });
    expect(rows[0].dueDay).toBe("2027-02-28");
    expect(rows[1].dueDay).toBe("2027-03-31");
  });

  it("refuses a non-positive principal (empty plan)", () => {
    expect(amortizeLoan({ principal: 0, annualRate: 0.05, termMonths: 12, startDay: "2027-01-01" })).toEqual([]);
    expect(amortizeLoan({ principal: -5, annualRate: 0.05, termMonths: 12, startDay: "2027-01-01" })).toEqual([]);
  });
});

describe("the status graph", () => {
  it("walks the happy path DRAFT → … → CLOSED", () => {
    expect(canTransitionLoan("DRAFT", "PENDING_APPROVAL")).toBe(true);
    expect(canTransitionLoan("PENDING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransitionLoan("APPROVED", "ACTIVE")).toBe(true);
    expect(canTransitionLoan("ACTIVE", "CLOSED")).toBe(true);
  });

  it("pre-ACTIVE states cancel; terminal states never move", () => {
    expect(canTransitionLoan("DRAFT", "CANCELLED")).toBe(true);
    expect(canTransitionLoan("PENDING_APPROVAL", "CANCELLED")).toBe(true);
    expect(canTransitionLoan("APPROVED", "CANCELLED")).toBe(true);
    expect(canTransitionLoan("ACTIVE", "CANCELLED")).toBe(false);
    expect(LOAN_TRANSITIONS.CLOSED).toEqual([]);
    expect(LOAN_TRANSITIONS.REJECTED).toEqual([]);
    expect(LOAN_TRANSITIONS.CANCELLED).toEqual([]);
    expect(isCancelableLoan("DRAFT")).toBe(true);
    expect(isCancelableLoan("PENDING_APPROVAL")).toBe(true);
    expect(isCancelableLoan("APPROVED")).toBe(true);
    expect(isCancelableLoan("ACTIVE")).toBe(false);
    expect(isCancelableLoan("CLOSED")).toBe(false);
  });

  it("PENDING_APPROVAL may be rejected; no state skips ahead", () => {
    expect(canTransitionLoan("PENDING_APPROVAL", "REJECTED")).toBe(true);
    expect(canTransitionLoan("DRAFT", "APPROVED")).toBe(false);
    expect(canTransitionLoan("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransitionLoan("APPROVED", "CLOSED")).toBe(false);
  });
});

describe("installmentsDueInPeriod", () => {
  const rows = [
    { dueDay: "2027-01-15", status: "SCHEDULED" },
    { dueDay: "2027-02-01", status: "SCHEDULED" },
    { dueDay: "2027-02-28", status: "SCHEDULED" },
  ];
  it("matches the rows whose due day falls inside the period", () => {
    expect(installmentsDueInPeriod(rows, "2027-01")).toEqual([rows[0]]);
    expect(installmentsDueInPeriod(rows, "2027-02")).toEqual([rows[1], rows[2]]);
    expect(installmentsDueInPeriod(rows, "2027-03")).toEqual([]);
  });
  it("accepts non-monthly keys via the window parser (a weekly span)", () => {
    // The week of Jan 11–17, 2027 contains the Jan 15 installment.
    expect(installmentsDueInPeriod(rows, "2027-W02")).toEqual([rows[0]]);
  });
  it("returns nothing for an unparseable key", () => {
    expect(installmentsDueInPeriod(rows, "not-a-period")).toEqual([]);
  });
});

describe("settlementPlan / loanSummary / fnfLoanReceivable", () => {
  it("the settlement plan is the outstanding principal plus the interest adjustment", () => {
    expect(settlementPlan({ outstandingBalance: 4_321.5, interestAdjustment: 0 })).toEqual({
      principal: 4_321.5, interest: 0, total: 4_321.5,
    });
    expect(settlementPlan({ outstandingBalance: 4_321.5, interestAdjustment: 55.55 })).toEqual({
      principal: 4_321.5, interest: 55.55, total: 4_377.05,
    });
    expect(settlementPlan({ outstandingBalance: -3, interestAdjustment: -1 })).toEqual({
      principal: 0, interest: 0, total: 0,
    });
  });
  it("the card summary names the outstanding of the principal", () => {
    expect(loanSummary({ principal: 10_000, outstandingBalance: 2_500, termMonths: 12 }).summary)
      .toBe("$2500.00 outstanding of $10000.00 · 12 months");
    expect(loanSummary({ principal: 10_000, outstandingBalance: 2_500, termMonths: 1 }).summary)
      .toBe("$2500.00 outstanding of $10000.00 · 1 month");
  });
  it("the FnF receivable flags outstanding > 0", () => {
    expect(fnfLoanReceivable({ principal: 8_000, outstanding: 3_000, typeName: "Housing" }))
      .toEqual({ outstanding: 3_000, isReceivable: true });
    expect(fnfLoanReceivable({ principal: 8_000, outstanding: 0, typeName: "Housing" }).isReceivable)
      .toBe(false);
  });
});

describe("isValidLoanInput (the validation twin)", () => {
  const base = { principal: 5_000, termMonths: 12, annualRate: 0.05, maxAmount: null as number | null, maxTermMonths: null as number | null };
  it("accepts a sane loan and enforces the type caps", () => {
    expect(isValidLoanInput(base)).toBeNull();
    expect(isValidLoanInput({ ...base, maxAmount: 4_000 })).toMatch(/maximum/i);
    expect(isValidLoanInput({ ...base, maxTermMonths: 6 })).toMatch(/term exceeds/i);
    expect(isValidLoanInput({ ...base, principal: 0 })).toMatch(/positive/i);
    expect(isValidLoanInput({ ...base, termMonths: 0 })).toMatch(/1–360/i);
    expect(isValidLoanInput({ ...base, annualRate: 1.5 })).toMatch(/between 0 and 1/i);
  });
  it("refuses out-of-range rates before amortizing; a 100% p.a. loan still amortizes sanely", () => {
    // 300% p.a. is out of the representable range — the range rail fires.
    expect(isValidLoanInput({ ...base, annualRate: 3, termMonths: 6 })).toMatch(/between 0 and 1/i);
    // Even the maximum representable rate retires principal on every row
    // (the annuity formula's own guarantee — the kernel's clamp is the belt).
    const rows = amortizeLoan({ principal: 1_000, annualRate: 1, termMonths: 6, startDay: "2027-01-01" });
    expect(rows.every((r) => r.principalPortion > 0)).toBe(true);
    expect(schedulePlanIsExact(rows, 1_000)).toBe(true);
  });
});
