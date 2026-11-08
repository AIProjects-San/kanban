import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// R7 — pure payroll math (docs/RECRUITMENT_MODULE_PLAN.md §5): structure →
// monthly lines, totals, pro-rated LOP, and the auto LOP-line management.
// ---------------------------------------------------------------------------

import {
  monthlyEarningsFromStructure,
  payslipTotals,
  computeLop,
  withLopLine,
  parsePayslipLines,
  daysInPeriod,
  currentPeriod,
  isPayrollPeriod,
  LOP_LINE_KEY,
  scaleEarningsToPaidDays,
  lopBasisGross,
  withRoundingLine,
  computeRoundingAdjustment,
  ROUNDING_LINE_KEY,
} from "@/lib/payroll-math";

const STRUCTURE = [
  { key: "basic", label: "Basic Salary", kind: "EARNING" as const, mode: "FIXED" as const, amount: 78_000 },
  { key: "transport", label: "Transport Allowance", kind: "EARNING" as const, mode: "FIXED" as const, amount: 2_400 },
  { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION" as const, mode: "PERCENT_OF_BASIC" as const, amount: 3 },
];

describe("payroll-math", () => {
  it("monthlyEarningsFromStructure: earnings ÷ 12, percent-of-basic resolved, employer contributions excluded", () => {
    const lines = monthlyEarningsFromStructure(STRUCTURE);
    expect(lines).toEqual([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ]);
  });

  it("monthlyEarningsFromStructure: percent-of-basic EARNINGS resolve off the basic anchor", () => {
    const lines = monthlyEarningsFromStructure([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 120_000 },
      { key: "commission", label: "Commission (10% of basic)", kind: "EARNING", mode: "PERCENT_OF_BASIC", amount: 10 },
    ]);
    // 120,000/12 = 10,000 basic + 12,000/12 = 1,000 commission.
    expect(lines.find((l) => l.key === "commission")?.amount).toBe(1_000);
  });

  it("payslipTotals: gross = Σ earnings, net = gross − Σ deductions, rounded to cents", () => {
    const t = payslipTotals(
      [{ key: "basic", label: "Basic", amount: 6_500.005 }, { key: "bonus", label: "Bonus", amount: 100 }],
      [{ key: "tax", label: "Tax", amount: 1_200.33 }],
    );
    expect(t.gross).toBe(6_600.01);
    expect(t.net).toBe(5_399.68);
  });

  it("daysInPeriod handles leap years and rejects junk with a 30-day fallback", () => {
    expect(daysInPeriod("2024-02")).toBe(29);
    expect(daysInPeriod("2026-02")).toBe(28);
    expect(daysInPeriod("2026-11")).toBe(30);
    expect(daysInPeriod("nonsense")).toBe(30);
  });

  it("computeLop is pro-rated: gross × days ÷ days-in-period", () => {
    // November (30 days): 6,000 × 3 / 30 = 600.
    expect(computeLop(6_000, 3, "2026-11")).toBe(600);
    // Zero days or zero gross → no deduction.
    expect(computeLop(6_000, 0, "2026-11")).toBe(0);
    expect(computeLop(0, 3, "2026-11")).toBe(0);
  });

  it("computeLop divides by the F1.1 working-day denominator when given", () => {
    // November 2026: 21 working days (holiday calendar) vs 30 calendar days.
    // 6,000 × 3 / 21 = 857.14 (2dp).
    expect(computeLop(6_000, 3, "2026-11", 21)).toBe(857.14);
    // A non-positive override falls back to the calendar length (pre-F1.1
    // runs store workingDays = 0).
    expect(computeLop(6_000, 3, "2026-11", 0)).toBe(600);
    expect(computeLop(6_000, 3, "2026-11", -1)).toBe(600);
  });

  it("withLopLine accepts the working-day denominator too", () => {
    const lop = withLopLine([], 6_000, 3, "2026-11", 21).find((l) => l.key === LOP_LINE_KEY);
    expect(lop?.amount).toBe(857.14);
  });

  it("withLopLine adds, replaces and removes the auto LOP line without touching manual lines", () => {
    const manual = [{ key: "tax", label: "Tax", amount: 100 }];
    const withLop = withLopLine(manual, 6_000, 2, "2026-11");
    expect(withLop).toHaveLength(2);
    const lop = withLopLine(manual, 6_000, 2, "2026-11").find((l) => l.key === LOP_LINE_KEY);
    expect(lop?.amount).toBe(400);
    expect(lop?.label).toContain("2 days");
    // A stale LOP line is replaced, not duplicated.
    const replaced = withLopLine(withLop, 6_000, 1, "2026-11");
    expect(replaced.filter((l) => l.key === LOP_LINE_KEY)).toHaveLength(1);
    expect(replaced.find((l) => l.key === LOP_LINE_KEY)?.amount).toBe(200);
    // lopDays 0 removes it entirely.
    expect(withLopLine(withLop, 6_000, 0, "2026-11")).toEqual(manual);
  });

  it("parsePayslipLines is defensive against corrupt JSON", () => {
    expect(parsePayslipLines("[]")).toEqual([]);
    expect(parsePayslipLines('{"nope":1}')).toEqual([]);
    expect(parsePayslipLines("not json")).toEqual([]);
    expect(parsePayslipLines('[{"key":"a","label":"A","amount":1},null,{"bad":true}]')).toEqual([
      { key: "a", label: "A", amount: 1 },
    ]);
  });

  it("currentPeriod / isPayrollPeriod", () => {
    expect(currentPeriod(new Date("2026-11-04T10:00:00Z"))).toBe("2026-11");
    expect(currentPeriod(new Date("2026-01-31T23:00:00Z"))).toBe("2026-01");
    expect(isPayrollPeriod("2026-11")).toBe(true);
    expect(isPayrollPeriod("2026-13")).toBe(false);
    expect(isPayrollPeriod("2026-1")).toBe(false);
    expect(isPayrollPeriod("26-11")).toBe(false);
  });
});


describe("scaleEarningsToPaidDays (S5 / PR-B06)", () => {
  const full = [
    { key: "basic", label: "Basic Salary", amount: 6_500 },
    { key: "transport", label: "Transport Allowance", amount: 200 },
  ];

  it("identity when paidDays equals the denominator (non-clipped byte-identical)", () => {
    expect(scaleEarningsToPaidDays(full, 21, 21)).toBe(full);
  });

  it("null / undefined paidDays or denominator returns the input unchanged (pre-S5 rows)", () => {
    expect(scaleEarningsToPaidDays(full, null, 21)).toBe(full);
    expect(scaleEarningsToPaidDays(full, undefined, 21)).toBe(full);
    expect(scaleEarningsToPaidDays(full, 5, undefined)).toBe(full);
    expect(scaleEarningsToPaidDays(full, 5, 0)).toBe(full);
  });

  it("scales each line by paidDays / denominator, rounded per line", () => {
    // 5 / 21: 6,500 → 1,547.62; 200 → 47.62.
    expect(scaleEarningsToPaidDays(full, 5, 21)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 1_547.62 },
      { key: "transport", label: "Transport Allowance", amount: 47.62 },
    ]);
  });

  it("does not mutate the input array (snapshot discipline)", () => {
    const input = [{ key: "basic", label: "Basic Salary", amount: 6_500 }];
    scaleEarningsToPaidDays(input, 5, 21);
    expect(input[0].amount).toBe(6_500);
  });
});


describe("PR-B02 (S6) — payment-days exemption", () => {
  const lines = [
    { key: "basic", label: "Basic Salary", amount: 6_500 },
    { key: "car", label: "Car Allowance", amount: 300, dependsOnPaymentDays: false },
    { key: "transport", label: "Transport Allowance", amount: 200 },
  ];

  it("scaleEarningsToPaidDays leaves exempt lines flat, scales the rest", () => {
    const scaled = scaleEarningsToPaidDays(lines, 10, 20);
    expect(scaled).toEqual([
      { key: "basic", label: "Basic Salary", amount: 3_250 },
      { key: "car", label: "Car Allowance", amount: 300, dependsOnPaymentDays: false },
      { key: "transport", label: "Transport Allowance", amount: 100 },
    ]);
  });

  it("lopBasisGross sums only day-scaled lines (exempt never docked by LOP)", () => {
    expect(lopBasisGross(lines)).toBe(6_700);
    expect(lopBasisGross([{ key: "car", label: "Car", amount: 300, dependsOnPaymentDays: false }])).toBe(0);
  });

  it("monthlyEarningsFromStructure snapshots the flag sparsely (only false)", () => {
    const out = monthlyEarningsFromStructure([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 78_000 },
      { key: "car", label: "Car", kind: "EARNING", mode: "FIXED", amount: 3_600, dependsOnPaymentDays: false },
    ]);
    expect(out).toEqual([
      { key: "basic", label: "Basic", amount: 6_500 },
      { key: "car", label: "Car", amount: 300, dependsOnPaymentDays: false },
    ]);
  });
});


describe("PR-B23 (S7) — the payslip rounding policy", () => {
  it("ROUND_2DP (default) never emits a rounding line and changes nothing", () => {
    const earnings = [{ key: "basic", label: "Basic", amount: 6_547.62 }];
    const out = withRoundingLine(earnings, [], "ROUND_2DP");
    expect(out.earnings).toEqual(earnings);
    expect(out.deductions).toEqual([]);
    expect(computeRoundingAdjustment(6_547.62, "ROUND_2DP")).toBe(0);
  });

  it("ROUND_NET_NEAREST pays UP with an earning line when the fraction is ≥ 0.5", () => {
    // net 100.60 → rounding +0.40 (earning side).
    const out = withRoundingLine([{ key: "basic", label: "Basic", amount: 100.6 }], [], "ROUND_NET_NEAREST");
    expect(out.earnings).toEqual([
      { key: "basic", label: "Basic", amount: 100.6 },
      { key: ROUNDING_LINE_KEY, label: "Rounding", amount: 0.4 },
    ]);
    expect(out.deductions).toEqual([]);
  });

  it("ROUND_NET_NEAREST docks DOWN with a deduction line when the fraction is < 0.5", () => {
    // net 100.40 → rounding −0.40 (deduction side, non-negative amount).
    const out = withRoundingLine([{ key: "basic", label: "Basic", amount: 100.4 }], [], "ROUND_NET_NEAREST");
    expect(out.earnings).toEqual([{ key: "basic", label: "Basic", amount: 100.4 }]);
    expect(out.deductions).toEqual([{ key: ROUNDING_LINE_KEY, label: "Rounding", amount: 0.4 }]);
  });

  it("an already-whole net emits nothing", () => {
    const out = withRoundingLine([{ key: "basic", label: "Basic", amount: 100 }], [], "ROUND_NET_NEAREST");
    expect(out.earnings).toEqual([{ key: "basic", label: "Basic", amount: 100 }]);
    expect(out.deductions).toEqual([]);
  });

  it("the line is replaced, never duplicated (idempotent re-run)", () => {
    const first = withRoundingLine([{ key: "basic", label: "Basic", amount: 100.6 }], [], "ROUND_NET_NEAREST");
    const second = withRoundingLine(first.earnings, first.deductions, "ROUND_NET_NEAREST");
    expect(second).toEqual(first);
  });

  it("computeRoundingAdjustment is the nearest-integer delta", () => {
    expect(computeRoundingAdjustment(99.4, "ROUND_NET_NEAREST")).toBe(-0.4);
    expect(computeRoundingAdjustment(99.5, "ROUND_NET_NEAREST")).toBe(0.5);
    expect(computeRoundingAdjustment(99.6, "ROUND_NET_NEAREST")).toBe(0.4);
    expect(computeRoundingAdjustment(0.01, "ROUND_NET_NEAREST")).toBe(-0.01);
    expect(computeRoundingAdjustment(0.99, "ROUND_NET_NEAREST")).toBe(0.01);
    expect(computeRoundingAdjustment(-10.4, "ROUND_NET_NEAREST")).toBe(0.4);
    expect(computeRoundingAdjustment(-10.6, "ROUND_NET_NEAREST")).toBe(-0.4);
  });
});


describe("PR-B03 (S8) — statistical (display-only) lines", () => {
  const structure = [
    { key: "basic", label: "Basic Salary", kind: "EARNING" as const, mode: "FIXED" as const, amount: 78_000 },
    { key: "package_note", label: "Total package", kind: "STATISTICAL" as const, mode: "FIXED" as const, amount: 120_000 },
  ];

  it("monthlyEarningsFromStructure rides statistical lines flagged, money unchanged", () => {
    const lines = monthlyEarningsFromStructure(structure);
    expect(lines).toEqual([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "package_note", label: "Total package", amount: 10_000, statistical: true },
    ]);
  });

  it("computeOffer counts STATISTICAL nowhere (earnings/net/ctc unchanged)", () => {
    const withStat = monthlyEarningsFromStructure(structure);
    const without = monthlyEarningsFromStructure(structure.filter((c) => c.kind !== "STATISTICAL"));
    expect(payslipTotals(withStat, []).gross).toBe(payslipTotals(without, []).gross);
    expect(payslipTotals(without, []).gross).toBe(6_500);
  });

  it("lineSum / lopBasisGross / scaling / rounding all skip statistical lines", () => {
    const lines = monthlyEarningsFromStructure(structure);
    expect(payslipTotals(lines, []).net).toBe(6_500);
    expect(lopBasisGross(lines)).toBe(6_500);
    const scaled = scaleEarningsToPaidDays(lines, 10, 20);
    expect(scaled.find((l) => l.key === "basic")?.amount).toBe(3_250);
    expect(scaled.find((l) => l.key === "package_note")?.amount).toBe(10_000);
    const rounded = withRoundingLine(lines, [], "ROUND_NET_NEAREST");
    expect(rounded.earnings.find((l) => l.key === "rounding")).toBeUndefined();
  });
});
