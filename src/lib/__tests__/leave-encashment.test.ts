import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P2 (LV-09, F2.2) — the leave-encashment kernel tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2.
//
// The contract: planLeaveEncashment's validation matrix (encashable flag,
// quarter steps, per-request cap, balance floor) and the F2.1
// GROSS_OVER_WORKING_DAYS rate math. Pure — no mocks, no db.
// ---------------------------------------------------------------------------

import { planLeaveEncashment, encashmentDailyRate, encashmentAmount } from "@/lib/leave-encashment";

const POLICY = { encashable: true, maxEncashableDays: 5, nonEncashableDays: 5 };

describe("planLeaveEncashment", () => {
  it("approves a lawful request", () => {
    expect(planLeaveEncashment(POLICY, 3, 20)).toEqual({ ok: true, days: 3 });
  });

  it("refuses a non-encashable type", () => {
    const plan = planLeaveEncashment({ ...POLICY, encashable: false }, 3, 20);
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("not encashable");
  });

  it("refuses zero/negative days", () => {
    expect(planLeaveEncashment(POLICY, 0, 20).ok).toBe(false);
    expect(planLeaveEncashment(POLICY, -1, 20).ok).toBe(false);
  });

  it("refuses non-quarter-day steps", () => {
    const plan = planLeaveEncashment(POLICY, 2.3, 20);
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("quarter-day");
  });

  it("enforces the per-request cap", () => {
    const plan = planLeaveEncashment(POLICY, 6, 20);
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("At most 5");
  });

  it("a zero cap means no per-request limit beyond the floor", () => {
    expect(planLeaveEncashment({ ...POLICY, maxEncashableDays: 0 }, 12, 20)).toEqual({ ok: true, days: 12 });
  });

  it("enforces the balance floor — the non-encashable days stay", () => {
    const plan = planLeaveEncashment(POLICY, 3, 7);
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("2 day(s) are encashable");
  });

  it("floor 0 = the whole balance may be sold (within the cap)", () => {
    expect(planLeaveEncashment({ ...POLICY, nonEncashableDays: 0 }, 5, 5)).toEqual({ ok: true, days: 5 });
  });

  it("refuses past the available balance (floor reason names the real headroom)", () => {
    const plan = planLeaveEncashment({ ...POLICY, maxEncashableDays: 0, nonEncashableDays: 0 }, 8, 7);
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("7 day(s) available");
  });
});

describe("encashmentDailyRate / encashmentAmount (F2.1 basis)", () => {
  it("monthly gross ÷ the payout period's working days", () => {
    // 6700 monthly ÷ 21 working days = 319.05.
    expect(encashmentDailyRate(6700, 21)).toBe(319.05);
  });

  it("guards degenerate inputs with zero, never NaN", () => {
    expect(encashmentDailyRate(-5, 21)).toBe(0);
    expect(encashmentDailyRate(6700, 0)).toBe(0);
    expect(encashmentDailyRate(Number.NaN, 21)).toBe(0);
  });

  it("amount = days × rate, rounded once", () => {
    expect(encashmentAmount(3, 319.05)).toBe(957.15);
    expect(encashmentAmount(2.5, 319.05)).toBe(797.63); // 797.625 → 797.63
    expect(encashmentAmount(0, 319.05)).toBe(0);
    expect(encashmentAmount(3, -1)).toBe(0);
  });
});
