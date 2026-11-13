import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge kernel tests:
// gross-basis rate, the payout plan's honesty rules, per-user minute sums.
// ---------------------------------------------------------------------------

import {
  overtimeHourlyRate,
  planOvertimePayout,
  overtimeLineLabel,
  sumOvertimeMinutes,
  OVERTIME_LINE_KEY,
} from "@/lib/payroll/overtime-bridge";

describe("overtimeHourlyRate (the gross basis)", () => {
  it("divides the monthly gross by working days × 8h, rounded once", () => {
    // 5,200 / 21 / 8 = 30.952… → 30.95
    expect(overtimeHourlyRate(5_200, 21)).toBe(30.95);
    // 6,700 / 22 / 8 = 38.068… → 38.07
    expect(overtimeHourlyRate(6_700, 22)).toBe(38.07);
  });

  it("is 0 without a gross or a positive denominator (never NaN/Infinity)", () => {
    expect(overtimeHourlyRate(null, 21)).toBe(0);
    expect(overtimeHourlyRate(5_200, 0)).toBe(0);
    expect(overtimeHourlyRate(5_200, -3)).toBe(0);
    expect(overtimeHourlyRate(0, 21)).toBe(0);
  });
});

describe("planOvertimePayout", () => {
  it("prices the period's minutes at the gross-basis rate", () => {
    // 120 min = 2h × 30.95 = 61.90
    const plan = planOvertimePayout({ enabled: true, minutes: 120, monthlyGross: 5_200, workingDays: 21 });
    expect(plan).toEqual({ minutes: 120, hours: 2, hourlyRate: 30.95, amount: 61.9 });
  });

  it("fractional hours keep 2 decimals and round the amount once", () => {
    // 95 min = 1.5833…h → 1.58 (rounded first, shown on the label);
    // 1.58 × 38.07 = 60.1506 → 60.15.
    const plan = planOvertimePayout({ enabled: true, minutes: 95, monthlyGross: 6_700, workingDays: 22 });
    expect(plan?.hours).toBe(1.58);
    expect(plan?.amount).toBe(60.15);
  });

  it("disabled knob → no plan (null, never a $0 line)", () => {
    expect(planOvertimePayout({ enabled: false, minutes: 120, monthlyGross: 5_200, workingDays: 21 })).toBeNull();
  });

  it("no minutes or uncomputable rate → no plan (null, never a fake zero)", () => {
    expect(planOvertimePayout({ enabled: true, minutes: 0, monthlyGross: 5_200, workingDays: 21 })).toBeNull();
    expect(planOvertimePayout({ enabled: true, minutes: null, monthlyGross: 5_200, workingDays: 21 })).toBeNull();
    expect(planOvertimePayout({ enabled: true, minutes: 120, monthlyGross: null, workingDays: 21 })).toBeNull();
    expect(planOvertimePayout({ enabled: true, minutes: 120, monthlyGross: 5_200, workingDays: 0 })).toBeNull();
  });

  it("the label shows its own work (hours + the rate it used)", () => {
    const plan = planOvertimePayout({ enabled: true, minutes: 150, monthlyGross: 5_200, workingDays: 21 });
    expect(plan).not.toBeNull();
    if (plan) expect(overtimeLineLabel(plan)).toBe("Overtime — 2h 30m at $30.95/h");
    expect(OVERTIME_LINE_KEY).toBe("overtime");
  });
});

describe("sumOvertimeMinutes", () => {
  it("sums per user, skipping null and non-positive rows", () => {
    const byUser = sumOvertimeMinutes([
      { userId: "a", overtimeMinutes: 90 },
      { userId: "a", overtimeMinutes: 30 },
      { userId: "b", overtimeMinutes: null },
      { userId: "c", overtimeMinutes: 0 },
      { userId: "d", overtimeMinutes: 15 },
    ]);
    expect([...byUser.entries()]).toEqual([["a", 120], ["d", 15]]);
  });

  it("empty input → empty map", () => {
    expect(sumOvertimeMinutes([]).size).toBe(0);
  });
});
