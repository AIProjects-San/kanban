import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P39 (EM-16's advances half) — the salary-advance kernel
// (lib/salary-advances.ts): the installment plan, the outstanding, the
// summary and the FnF receivable derivation.
// ---------------------------------------------------------------------------

import {
  installmentPlan,
  outstandingAdvance,
  advanceSummary,
  isValidAdvanceInput,
  fnfAdvanceReceivable,
} from "@/lib/salary-advances";

describe("installmentPlan", () => {
  it("one installment is the amount itself", () => {
    expect(installmentPlan(500, 1)).toEqual([500]);
  });

  it("an even split stays even (1200 / 4 → 300 × 4)", () => {
    expect(installmentPlan(1_200, 4)).toEqual([300, 300, 300, 300]);
  });

  it("the LAST installment absorbs the rounding remainder (1000 / 3)", () => {
    const plan = installmentPlan(1_000, 3);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toBe(333.33);
    expect(plan[2]).toBe(333.34); // 1000 − 333.33×2
    expect(plan.reduce((s, p) => s + p, 0)).toBe(1_000);
  });

  it("the plan always sums to the amount exactly (never a stray cent)", () => {
    for (const [amount, n] of [[777.77, 5], [0.10, 3], [12_345.67, 7]] as const) {
      const plan = installmentPlan(amount, n);
      expect(Math.round(plan.reduce((s, p) => s + p, 0) * 100) / 100).toBe(amount);
    }
  });

  it("a non-positive amount yields no plan", () => {
    expect(installmentPlan(0, 4)).toEqual([]);
    expect(installmentPlan(-5, 4)).toEqual([]);
  });
});

describe("outstandingAdvance", () => {
  it("OPEN: amount minus the consumed total, floored at zero", () => {
    expect(outstandingAdvance({ amount: 1_200, status: "OPEN" }, 300)).toBe(900);
    expect(outstandingAdvance({ amount: 1_200, status: "OPEN" }, 1_200)).toBe(0);
    expect(outstandingAdvance({ amount: 500, status: "OPEN" }, 600)).toBe(0); // floored
  });

  it("RECOVERED: always zero (the row is the record)", () => {
    expect(outstandingAdvance({ amount: 1_200, status: "RECOVERED" }, 300)).toBe(0);
  });
});

describe("advanceSummary", () => {
  it("single-installment OPEN: '$X outstanding'", () => {
    expect(advanceSummary({ amount: 500, status: "OPEN", installments: 1, consumedCount: 0, consumedTotal: 0 }))
      .toEqual({ outstanding: 500, summary: "$500.00 outstanding" });
  });

  it("multi-installment: '2 of 4 installments repaid'", () => {
    const out = advanceSummary({ amount: 1_200, status: "OPEN", installments: 4, consumedCount: 2, consumedTotal: 600 });
    expect(out.outstanding).toBe(600);
    expect(out.summary).toBe("$600.00 outstanding · 2 of 4 installments repaid");
  });

  it("RECOVERED: 'recovered in full (N installments)'", () => {
    expect(advanceSummary({ amount: 1_200, status: "RECOVERED", installments: 4, consumedCount: 4, consumedTotal: 1_200 }).summary)
      .toBe("recovered in full (4 installments)");
  });
});

describe("isValidAdvanceInput", () => {
  it("positive amount + 1..24 installments + YYYY-MM", () => {
    expect(isValidAdvanceInput({ amount: 500, installments: 4, startPeriod: "2026-12" })).toBe(true);
    expect(isValidAdvanceInput({ amount: 500, installments: 1, startPeriod: "2026-01" })).toBe(true);
  });

  it("refuses bad amounts / installments / period shapes", () => {
    expect(isValidAdvanceInput({ amount: 0, installments: 4, startPeriod: "2026-12" })).toBe(false);
    expect(isValidAdvanceInput({ amount: 500, installments: 0, startPeriod: "2026-12" })).toBe(false);
    expect(isValidAdvanceInput({ amount: 500, installments: 25, startPeriod: "2026-12" })).toBe(false);
    expect(isValidAdvanceInput({ amount: 500, installments: 2.5, startPeriod: "2026-12" })).toBe(false);
    expect(isValidAdvanceInput({ amount: 500, installments: 4, startPeriod: "2026-13" })).toBe(false);
    expect(isValidAdvanceInput({ amount: 500, installments: 4, startPeriod: "26-12" })).toBe(false);
  });
});

describe("fnfAdvanceReceivable", () => {
  it("an outstanding OPEN advance is a receivable", () => {
    expect(fnfAdvanceReceivable({ amount: 1_200, status: "OPEN", consumedTotal: 300 }))
      .toEqual({ outstanding: 900, isReceivable: true });
  });

  it("fully consumed or RECOVERED advances are not", () => {
    expect(fnfAdvanceReceivable({ amount: 1_200, status: "OPEN", consumedTotal: 1_200 }).isReceivable).toBe(false);
    expect(fnfAdvanceReceivable({ amount: 1_200, status: "RECOVERED", consumedTotal: 0 }).isReceivable).toBe(false);
  });
});
