import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P4 (PR-14/PR-B12, F3.1) — the LWP-correction kernel tests.
// ---------------------------------------------------------------------------

import { planLwpCorrection, lwpCreditLabel } from "@/lib/lwp-correction";

describe("planLwpCorrection", () => {
  it("prices a lawful reversal from the stored LOP line's per-day rate", () => {
    // 6700 gross, 2 LOP days over 22 working days → LOP line 609.09;
    // per day 304.55 (round2(609.09/2) = 304.55); reversing 1 day = 304.55.
    const plan = planLwpCorrection({
      storedLopDays: 2, storedLopAmount: 609.09, requestedDays: 1, alreadyReversedDays: 0,
    });
    expect(plan).toMatchObject({ ok: true, days: 1, perDay: 304.55, credit: 304.55 });
  });

  it("fractional days price at the same per-day rate", () => {
    const plan = planLwpCorrection({
      storedLopDays: 2, storedLopAmount: 609.09, requestedDays: 0.5, alreadyReversedDays: 0,
    });
    expect(plan).toMatchObject({ ok: true, days: 0.5, credit: 152.28 }); // 152.275 → 152.28
  });

  it("refuses a slip with no LOP days", () => {
    const plan = planLwpCorrection({ storedLopDays: 0, storedLopAmount: 0, requestedDays: 1, alreadyReversedDays: 0 });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("no loss-of-pay");
  });

  it("refuses a degenerate stored LOP amount", () => {
    const plan = planLwpCorrection({ storedLopDays: 2, storedLopAmount: 0, requestedDays: 1, alreadyReversedDays: 0 });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("no amount");
  });

  it("refuses zero/negative days and non-quarter steps", () => {
    expect(planLwpCorrection({ storedLopDays: 2, storedLopAmount: 500, requestedDays: 0, alreadyReversedDays: 0 }).ok).toBe(false);
    expect(planLwpCorrection({ storedLopDays: 2, storedLopAmount: 500, requestedDays: 0.3, alreadyReversedDays: 0 }).ok).toBe(false);
  });

  it("enforces the reversal cap including prior reversals", () => {
    const plan = planLwpCorrection({
      storedLopDays: 3, storedLopAmount: 900, requestedDays: 2, alreadyReversedDays: 1.5,
    });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain("1.5 day(s) are still reversible");
  });

  it("the full remaining cap is reversible", () => {
    const plan = planLwpCorrection({
      storedLopDays: 3, storedLopAmount: 900, requestedDays: 1.5, alreadyReversedDays: 1.5,
    });
    expect(plan).toMatchObject({ ok: true, days: 1.5, credit: 450 });
  });
});

describe("lwpCreditLabel", () => {
  it("names the period, slip and days", () => {
    expect(lwpCreditLabel("2026-10", "PS-2026-10-004", 1.5)).toBe("LWP correction — 2026-10 (PS-2026-10-004, 1.5d)");
  });
});
