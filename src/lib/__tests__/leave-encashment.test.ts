import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P2 (LV-09, F2.2) — the leave-encashment kernel tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2.
//
// The contract: planLeaveEncashment's validation matrix (encashable flag,
// quarter steps, per-request cap, balance floor) and the F2.1
// GROSS_OVER_WORKING_DAYS rate math. Pure — no mocks, no db.
// ---------------------------------------------------------------------------

import {
  planLeaveEncashment,
  encashmentDailyRate,
  encashmentAmount,
  dueEncashmentAutoDrafts,
  nextPayoutPeriod,
  type EncashmentAutoDraftCandidate,
  type EncashmentAutoDraftSwitches,
} from "@/lib/leave-encashment";

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

// ---------------------------------------------------------------------------
// P31 (LV-J02 / LV-09's remainder) — the auto-draft planner. One rule, both
// callers: every planned draft re-validates through planLeaveEncashment, so
// the matrix below double-pins the invariant.
// ---------------------------------------------------------------------------

const SWITCH_ON: EncashmentAutoDraftSwitches = { autoLeaveEncashment: true };

function candidate(overrides: Partial<EncashmentAutoDraftCandidate>): EncashmentAutoDraftCandidate {
  return {
    userId: "u-1",
    leaveTypeId: "lt-1",
    leaveTypeName: "Annual Leave",
    policy: POLICY,
    availableDays: 20,
    hasLiveDraft: false,
    hasRejectedDraft: false,
    ...overrides,
  };
}

describe("nextPayoutPeriod (the day-after-month key)", () => {
  it("rolls November into December, and December into next January", () => {
    expect(nextPayoutPeriod("2026-11-10")).toBe("2026-12");
    expect(nextPayoutPeriod("2026-12-25")).toBe("2027-01");
    expect(nextPayoutPeriod("2027-01-31")).toBe("2027-02");
  });

  it("pads single-digit months", () => {
    expect(nextPayoutPeriod("2026-03-09")).toBe("2026-04");
  });
});

describe("dueEncashmentAutoDrafts (the pure rule)", () => {
  it("the switch off → not a single draft (the workspace gate)", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({})],
      switches: { autoLeaveEncashment: false },
    });
    expect(drafts).toHaveLength(0);
  });

  it("drafts the days above the floor, capped per request — payout = next month", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({})],
      switches: SWITCH_ON,
    });
    expect(drafts).toEqual([
      {
        userId: "u-1",
        leaveTypeId: "lt-1",
        leaveTypeName: "Annual Leave",
        days: 5, // min(20 − 5 floor, 5 cap)
        payoutPeriod: "2026-12",
      },
    ]);
  });

  it("a zero cap = no per-request limit — the whole over-floor balance", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({ policy: { ...POLICY, maxEncashableDays: 0 } })],
      switches: SWITCH_ON,
    });
    expect(drafts[0].days).toBe(15); // 20 − 5 floor
  });

  it("a non-encashable type never drafts", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({ policy: { ...POLICY, encashable: false } })],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(0);
  });

  it("a live draft (PENDING or APPROVED-unpaid) blocks the pair — the idempotency rule", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({ hasLiveDraft: true })],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(0);
  });

  it("a rejected draft stands for the year — no daily re-litigation of a no", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({ hasRejectedDraft: true })],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(0);
  });

  it("at or below the floor → nothing to sell", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [
        candidate({ availableDays: 5 }), // exactly the floor
        candidate({ availableDays: 3 }), // under it
      ],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(0);
  });

  it("fractional headroom floors to quarter-day steps (10.3 → 10.25)", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [candidate({ policy: { ...POLICY, maxEncashableDays: 0, nonEncashableDays: 0 }, availableDays: 10.3 })],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].days).toBe(10.25);
  });

  it("headroom under a quarter day drafts nothing", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-11-10",
      candidates: [
        candidate({ policy: { ...POLICY, maxEncashableDays: 0, nonEncashableDays: 0 }, availableDays: 0.1 }),
        candidate({ policy: { ...POLICY, maxEncashableDays: 0 }, availableDays: 5.1 }), // floor 5 → headroom 0.1
      ],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(0);
  });

  it("every planned draft survives planLeaveEncashment verbatim (one rule, both callers)", () => {
    // The invariant loop: for a matrix of knobs and balances, each planned
    // days value must be exactly what the member-facing validation accepts.
    const knobs = [
      { encashable: true, maxEncashableDays: 0, nonEncashableDays: 0 },
      { encashable: true, maxEncashableDays: 5, nonEncashableDays: 5 },
      { encashable: true, maxEncashableDays: 45, nonEncashableDays: 1 },
      POLICY,
    ];
    const balances = [0.1, 0.25, 1.5, 5, 7.75, 10.3, 20, 61];
    for (const policy of knobs) {
      for (const availableDays of balances) {
        const drafts = dueEncashmentAutoDrafts({
          asOf: "2026-11-10",
          candidates: [candidate({ policy, availableDays })],
          switches: SWITCH_ON,
        });
        for (const d of drafts) {
          const plan = planLeaveEncashment(policy, d.days, availableDays);
          expect(plan.ok, `policy ${JSON.stringify(policy)} / avail ${availableDays} → days ${d.days}`).toBe(true);
          if (plan.ok) expect(plan.days).toBe(d.days);
        }
      }
    }
  });

  it("two pairs plan independently (different floors, different types)", () => {
    const drafts = dueEncashmentAutoDrafts({
      asOf: "2026-12-01",
      candidates: [
        candidate({}),
        candidate({
          userId: "u-2",
          leaveTypeId: "lt-2",
          leaveTypeName: "Sick Leave",
          policy: { encashable: true, maxEncashableDays: 0, nonEncashableDays: 2 },
          availableDays: 8,
        }),
      ],
      switches: SWITCH_ON,
    });
    expect(drafts).toHaveLength(2);
    expect(drafts[1].days).toBe(6);
    expect(drafts[1].payoutPeriod).toBe("2027-01"); // December rolls over
  });
});
