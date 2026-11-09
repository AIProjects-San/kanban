import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P1 (PR-12/PR-B10, F2.3) — the PayAdjustment kernel tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep.
//
// The two-pass ordering spec is the contract under test:
//   Pass 1: FIXED lines, then PERCENT_OF_GROSS (earnings before deductions,
//     so a % -of-gross deduction sees the raised gross).
//   Pass 2: PERCENT_OF_NET deductions sequentially on the running net.
// Plus: isDueInPeriod's recurrence windows, OVERWRITE semantics, merge by
// shared code, skip reasons (never silent), and the S7 rounding interplay.
// ---------------------------------------------------------------------------

import {
  applyAdjustments,
  isDueInPeriod,
  validateAdjustmentInput,
  adjustmentLineKey,
  type PayAdjustmentRow,
} from "@/lib/pay-adjustment";
import { withRoundingLine, payslipTotals } from "@/lib/payroll-math";
import type { PayslipLine } from "@/lib/payroll-math";

function row(overrides: Partial<PayAdjustmentRow> & Pick<PayAdjustmentRow, "id">): PayAdjustmentRow {
  return {
    userId: "u-1",
    sourceType: "MANUAL",
    sourceId: "",
    componentCode: "",
    label: "Adjustment",
    side: "EARNING",
    recurrence: "ONE_SHOT",
    calcMode: "FIXED",
    percent: null,
    amount: 0,
    period: "2026-12",
    endPeriod: null,
    lastConsumedPeriod: "",
    status: "PENDING",
    skipReason: "",
    note: "",
    ...overrides,
  };
}

const base = (earnings: Array<[string, number]>, deductions: Array<[string, number]> = []) => ({
  earnings: earnings.map(([key, amount]) => ({ key, label: key, amount })) as PayslipLine[],
  deductions: deductions.map(([key, amount]) => ({ key, label: key, amount })) as PayslipLine[],
});

describe("isDueInPeriod", () => {
  it("ONE_SHOT is due only on its exact period", () => {
    const r = row({ id: "a1", period: "2026-12" });
    expect(isDueInPeriod(r, "2026-12")).toBe(true);
    expect(isDueInPeriod(r, "2026-11")).toBe(false);
    expect(isDueInPeriod(r, "2027-01")).toBe(false);
  });

  it("RECURRING is due from its first period through endPeriod inclusive", () => {
    const r = row({ id: "a2", recurrence: "RECURRING", period: "2026-10", endPeriod: "2027-02" });
    expect(isDueInPeriod(r, "2026-09")).toBe(false);
    expect(isDueInPeriod(r, "2026-10")).toBe(true);
    expect(isDueInPeriod(r, "2027-01")).toBe(true);
    expect(isDueInPeriod(r, "2027-02")).toBe(true);
    expect(isDueInPeriod(r, "2027-03")).toBe(false);
  });

  it("RECURRING without endPeriod is open-ended", () => {
    const r = row({ id: "a3", recurrence: "RECURRING", period: "2026-10", endPeriod: null });
    expect(isDueInPeriod(r, "2027-12")).toBe(true);
    expect(isDueInPeriod(r, "2026-09")).toBe(false);
  });

  it("OVERWRITE is due only on its single period", () => {
    const r = row({ id: "a4", recurrence: "OVERWRITE", period: "2026-12" });
    expect(isDueInPeriod(r, "2026-12")).toBe(true);
    expect(isDueInPeriod(r, "2026-11")).toBe(false);
  });
});

describe("validateAdjustmentInput", () => {
  it("accepts a well-formed FIXED earning", () => {
    expect(
      validateAdjustmentInput({
        side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED", percent: null,
        amount: 500, period: "2026-12", endPeriod: null, label: "Bonus", componentCode: "",
      }),
    ).toBeNull();
  });

  it("refuses percent modes without a valid percent", () => {
    expect(
      validateAdjustmentInput({
        side: "DEDUCTION", recurrence: "ONE_SHOT", calcMode: "PERCENT_OF_GROSS", percent: null,
        amount: 0, period: "2026-12", endPeriod: null, label: "X", componentCode: "",
      }),
    ).toContain("percent");
  });

  it("refuses percent-of-net on the EARNING side (deduction-only mode)", () => {
    expect(
      validateAdjustmentInput({
        side: "EARNING", recurrence: "ONE_SHOT", calcMode: "PERCENT_OF_NET", percent: 5,
        amount: 0, period: "2026-12", endPeriod: null, label: "X", componentCode: "",
      }),
    ).toContain("deduction-only");
  });

  it("refuses endPeriod before the first period", () => {
    expect(
      validateAdjustmentInput({
        side: "EARNING", recurrence: "RECURRING", calcMode: "FIXED", percent: null,
        amount: 10, period: "2026-12", endPeriod: "2026-11", label: "X", componentCode: "",
      }),
    ).toContain("endPeriod");
  });

  it("refuses a row with neither label nor component code", () => {
    expect(
      validateAdjustmentInput({
        side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED", percent: null,
        amount: 10, period: "2026-12", endPeriod: null, label: "  ", componentCode: "",
      }),
    ).toContain("label");
  });
});

describe("applyAdjustments", () => {
  it("lands a FIXED earning line and a FIXED deduction line", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [
        row({ id: "e1", label: "Q4 bonus", amount: 800 }),
        row({ id: "d1", label: "Advance recovery", side: "DEDUCTION", amount: 200 }),
      ],
      "2026-12",
    );
    expect(out.earnings.find((l) => l.key === "adj:e1")).toMatchObject({ label: "Q4 bonus", amount: 800 });
    expect(out.deductions.find((l) => l.key === "adj:d1")).toMatchObject({ amount: 200 });
    const { gross, net } = payslipTotals(out.earnings, out.deductions);
    expect(gross).toBe(5800);
    expect(net).toBe(5600);
    expect(out.consumed.map((c) => c.id)).toEqual(["e1", "d1"]);
    expect(out.skipped).toEqual([]);
  });

  it("never mutates the input arrays (purity)", () => {
    const b = base([["BASIC", 5000]]);
    const before = JSON.stringify(b);
    applyAdjustments(b, [row({ id: "e2", amount: 100 })], "2026-12");
    expect(JSON.stringify(b)).toBe(before);
  });

  it("PERCENT_OF_GROSS deduction sees the gross INCLUDING same-slip adjustment earnings (pass-1 order)", () => {
    const out = applyAdjustments(
      base([["BASIC", 4000]]),
      [
        row({ id: "e3", label: "Bonus", amount: 1000 }),
        row({ id: "d2", label: "Levy", side: "DEDUCTION", calcMode: "PERCENT_OF_GROSS", percent: 10 }),
      ],
      "2026-12",
    );
    // gross = 4000 + 1000 = 5000 → levy = 500 (not 400).
    expect(out.deductions.find((l) => l.key === "adj:d2")?.amount).toBe(500);
    expect(payslipTotals(out.earnings, out.deductions).net).toBe(4500);
  });

  it("PERCENT_OF_NET deductions resolve sequentially on the running net (no fixed point)", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]], [["lop", 500]]),
      [
        row({ id: "n1", label: "Fee A", side: "DEDUCTION", calcMode: "PERCENT_OF_NET", percent: 10 }),
        row({ id: "n2", label: "Fee B", side: "DEDUCTION", calcMode: "PERCENT_OF_NET", percent: 10 }),
      ],
      "2026-12",
    );
    // net after LOP = 4500 → A = 450 → 4050 → B = 405 → 3645.
    expect(out.deductions.find((l) => l.key === "adj:n1")?.amount).toBe(450);
    expect(out.deductions.find((l) => l.key === "adj:n2")?.amount).toBe(405);
    expect(payslipTotals(out.earnings, out.deductions).net).toBe(3645);
  });

  it("skips a PERCENT_OF_NET earning with a visible reason", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [row({ id: "bad1", calcMode: "PERCENT_OF_NET", percent: 5, label: "X" })],
      "2026-12",
    );
    expect(out.consumed).toEqual([]);
    expect(out.skipped).toEqual([{ id: "bad1", reason: "percent-of-net is deduction-only" }]);
  });

  it("OVERWRITE replaces the same-key line's amount for its period", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [row({ id: "o1", componentCode: "BASIC", recurrence: "OVERWRITE", amount: 5500 })],
      "2026-12",
    );
    expect(out.earnings.find((l) => l.key === "BASIC")?.amount).toBe(5500);
    expect(out.earnings).toHaveLength(1);
    expect(out.consumed[0]).toMatchObject({ id: "o1", final: true });
  });

  it("OVERWRITE with no matching line is skipped with a reason", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [row({ id: "o2", componentCode: "TRANSPORT", recurrence: "OVERWRITE", amount: 100 })],
      "2026-12",
    );
    expect(out.skipped).toEqual([{ id: "o2", reason: "no matching line to overwrite" }]);
    expect(out.consumed).toEqual([]);
  });

  it("rows sharing a componentCode merge (amounts sum, first label wins)", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [
        row({ id: "m1", componentCode: "BONUS", label: "Performance bonus", amount: 300 }),
        row({ id: "m2", componentCode: "BONUS", label: "Second bonus", amount: 200 }),
      ],
      "2026-12",
    );
    const merged = out.earnings.find((l) => l.key === "BONUS");
    expect(merged).toMatchObject({ label: "Performance bonus", amount: 500 });
  });

  it("marks RECURRING consumption intermediate before endPeriod, final on it", () => {
    const r = row({ id: "r1", recurrence: "RECURRING", period: "2026-10", endPeriod: "2027-01", amount: 50 });
    const mid = applyAdjustments(base([["BASIC", 5000]]), [r], "2026-12");
    expect(mid.consumed[0]).toMatchObject({ id: "r1", final: false });
    const last = applyAdjustments(base([["BASIC", 5000]]), [{ ...r }], "2027-01");
    expect(last.consumed[0]).toMatchObject({ id: "r1", final: true });
  });

  it("open-ended RECURRING rows are never final", () => {
    const r = row({ id: "r2", recurrence: "RECURRING", period: "2026-10", endPeriod: null, amount: 50 });
    const out = applyAdjustments(base([["BASIC", 5000]]), [r], "2027-05");
    expect(out.consumed[0]).toMatchObject({ final: false });
  });

  it("invalid percent/amount rows from foreign writers are skipped, not NaN'd", () => {
    const out = applyAdjustments(
      base([["BASIC", 5000]]),
      [
        row({ id: "x1", calcMode: "PERCENT_OF_GROSS", percent: null }),
        row({ id: "x2", amount: -50 }),
      ],
      "2026-12",
    );
    expect(out.skipped.map((s) => s.id)).toEqual(["x1", "x2"]);
    expect(out.earnings.every((l) => Number.isFinite(l.amount))).toBe(true);
  });

  it("statistical base lines ride untouched and never merge into", () => {
    const out = applyAdjustments(
      { earnings: [{ key: "CTC_INFO", label: "CTC (info)", amount: 60000, statistical: true }], deductions: [] },
      [row({ id: "s1", amount: 100 })],
      "2026-12",
    );
    expect(out.earnings.find((l) => l.key === "CTC_INFO")?.statistical).toBe(true);
    expect(out.earnings.find((l) => l.key === "adj:s1")).toBeDefined();
  });

  it("adjustments land BEFORE the S7 rounding line wraps the final net", () => {
    const applied = applyAdjustments(
      base([["BASIC", 4999.4]]),
      [row({ id: "e9", amount: 100 })],
      "2026-12",
    );
    const { earnings, deductions } = withRoundingLine(applied.earnings, applied.deductions, "ROUND_NET_NEAREST");
    const net = payslipTotals(earnings, deductions).net;
    expect(net).toBe(5099); // 5099.4 → rounding line docks 0.4
    expect(deductions.find((l) => l.key === "rounding")?.amount).toBe(0.4);
  });
});

describe("adjustmentLineKey", () => {
  it("uses the component code when present, else adj:<id>", () => {
    expect(adjustmentLineKey({ id: "z1", componentCode: "BONUS" })).toBe("BONUS");
    expect(adjustmentLineKey({ id: "z1", componentCode: "  " })).toBe("adj:z1");
  });
});

// ---------------------------------------------------------------------------
// P10 (PR-B05) — cross-cadence due-ness. Monthly keys keep their pre-P10
// semantics (proven by the suite above); these pin the window rules that
// make mixed-cadence workspaces safe.
// ---------------------------------------------------------------------------
describe("isDueInPeriod — cross-cadence (P10)", () => {
  it("ONE_SHOT targeted at a month pays in the runs whose windows meet it", () => {
    const r = row({ id: "x1", period: "2026-11" });
    // A weekly run inside November (W45 starts Nov 2 — inside [Nov 1, Nov 30]).
    expect(isDueInPeriod(r, "2026-W45")).toBe(true);
    // W44 (Oct 26 – Nov 1) OVERLAPS November on Nov 1 — the benchmark's
    // date-overlap selection includes it (the first run covering any of the
    // target's days carries the one-shot money).
    expect(isDueInPeriod(r, "2026-W44")).toBe(true);
    // December weeks are past the month window (W50 = Dec 7 – Dec 13; even
    // W49, which overlaps Nov 30 only, is due by the overlap rule).
    expect(isDueInPeriod(r, "2026-W49")).toBe(true);
    expect(isDueInPeriod(r, "2026-W50")).toBe(false);
    // The bimonthly halves both meet the month.
    expect(isDueInPeriod(r, "2026-11-A")).toBe(true);
    expect(isDueInPeriod(r, "2026-11-B")).toBe(true);
    // Adjacent months do not.
    expect(isDueInPeriod(r, "2026-10-B")).toBe(false);
    expect(isDueInPeriod(r, "2026-12-A")).toBe(false);
  });

  it("ONE_SHOT targeted at a week pays in the covering monthly run", () => {
    const r = row({ id: "x2", period: "2026-W45" }); // Nov 2 – Nov 8
    expect(isDueInPeriod(r, "2026-11")).toBe(true); // the month's start is inside the week? no — the WEEK is inside the month
    expect(isDueInPeriod(r, "2026-10")).toBe(false);
    expect(isDueInPeriod(r, "2026-12")).toBe(false);
    expect(isDueInPeriod(r, "2026-W45")).toBe(true);
    expect(isDueInPeriod(r, "2026-W46")).toBe(false);
  });

  it("ONE_SHOT daily keys meet exactly their covering windows", () => {
    const r = row({ id: "x3", period: "2026-11-09" });
    expect(isDueInPeriod(r, "2026-11-09")).toBe(true);
    expect(isDueInPeriod(r, "2026-11")).toBe(true); // the day is inside the month
    expect(isDueInPeriod(r, "2026-W46")).toBe(true); // Mon Nov 9 is inside week 46
    expect(isDueInPeriod(r, "2026-11-A")).toBe(true); // day 9 is in the first half
    expect(isDueInPeriod(r, "2026-11-B")).toBe(false);
    expect(isDueInPeriod(r, "2026-11-10")).toBe(false);
  });

  it("RECURRING rows fire in every run whose window starts inside the span", () => {
    const r = row({ id: "x4", recurrence: "RECURRING", period: "2026-11", endPeriod: "2026-12" });
    // Weekly runs whose windows START within Nov 1 – Dec 1 are all due
    // (the benchmark's own cross-frequency repetition, documented).
    expect(isDueInPeriod(r, "2026-W45")).toBe(true); // starts Nov 2
    expect(isDueInPeriod(r, "2026-W49")).toBe(true); // starts Nov 30
    expect(isDueInPeriod(r, "2026-W50")).toBe(false); // starts Dec 7 — past Dec 1
    expect(isDueInPeriod(r, "2026-W44")).toBe(false); // starts Oct 26 — before Nov 1
    expect(isDueInPeriod(r, "2026-12")).toBe(true);
    expect(isDueInPeriod(r, "2027-01")).toBe(false);
  });

  it("unparseable keys are never due (no fake January)", () => {
    const r = row({ id: "x5", period: "2026-11" });
    expect(isDueInPeriod(r, "garbage")).toBe(false);
    expect(isDueInPeriod({ ...r, period: "junk" }, "2026-11")).toBe(false);
    expect(isDueInPeriod({ ...r, recurrence: "RECURRING", endPeriod: "junk" }, "2026-11")).toBe(false);
  });
});

describe("validateAdjustmentInput — P10 cadence keys", () => {
  const ok = (period: string, endPeriod: string | null = null) =>
    validateAdjustmentInput({
      side: "EARNING",
      recurrence: "RECURRING",
      calcMode: "FIXED",
      percent: null,
      amount: 10,
      period,
      endPeriod,
      label: "Test",
      componentCode: "",
    });

  it("accepts every cadence key", () => {
    expect(ok("2026-11", "2026-12")).toBeNull();
    expect(ok("2026-11-A", "2026-12-B")).toBeNull();
    expect(ok("2026-W45", "2026-W53")).toBeNull();
    expect(ok("2026-F23", "2026-F27")).toBeNull();
    expect(ok("2026-11-09", "2026-11-09")).toBeNull();
    expect(ok("2026-Q4", null)).toBeNull();
    expect(ok("2026", null)).toBeNull();
  });

  it("rejects malformed keys and inverted spans by window start", () => {
    expect(ok("banana", null)).toMatch(/period must be a payroll period key/);
    // An unparseable endPeriod is rejected by the endPeriod guard (treated
    // as an invalid span boundary before the key-format check can run).
    expect(ok("2026-11", "2026-99")).toBe("endPeriod cannot be before the first period");
    // endPeriod's window starts BEFORE period's window start.
    expect(ok("2026-W46", "2026-W45")).toBe("endPeriod cannot be before the first period");
    // Cross-cadence inversion: W46 starts Nov 9, later than Nov 1.
    expect(ok("2026-11", "2026-W44")).toBe("endPeriod cannot be before the first period");
    // …while W45 (starts Nov 2) is after November's start — allowed.
    expect(ok("2026-11", "2026-W45")).toBeNull();
  });
});
