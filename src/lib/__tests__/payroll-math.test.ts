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
