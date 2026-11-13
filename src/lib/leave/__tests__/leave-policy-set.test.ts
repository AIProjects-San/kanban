import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P28 (LV-02/LV-03) — the leave policy set kernel's matrix: the set
// validation refusals, the assignment window targeting (named window /
// implicit calendar year / the gap refusal), the bucket candidates the
// assign modal offers, the row-level entitlement override (the null-cap
// follow rule), and the MANUAL materialization's DOJ pro-rata riding
// F2.4's own formula.
// ---------------------------------------------------------------------------

import {
  assignmentBucketCandidates,
  assignmentWindowFor,
  assignedManualGrantDays,
  assignedManualPreview,
  joinsMidWindow,
  policyRowWithAnnualDays,
  validatePolicySet,
} from "@/lib/leave/leave-policy-set";
import { resolveLeavePolicy, proRateAnnualDays } from "@/lib/leave/leave-policy";

const BASE_POLICY = {
  annualDays: 20,
  maxCarryOver: 5,
  minNoticeDays: 1,
  maxConsecutiveDays: 15,
};

describe("validatePolicySet", () => {
  it("accepts a well-formed set", () => {
    const res = validatePolicySet({
      name: "Standard 2027",
      description: "everyone",
      items: [
        { leaveTypeId: "t-annual", annualDays: 25 },
        { leaveTypeId: "t-sick", annualDays: 8 },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it("refuses an empty name, an oversized name and an oversized description", () => {
    expect(validatePolicySet({ name: "   ", items: [{ leaveTypeId: "t", annualDays: 1 }] }).ok).toBe(false);
    expect(validatePolicySet({ name: "x".repeat(81), items: [{ leaveTypeId: "t", annualDays: 1 }] }).ok).toBe(false);
    expect(
      validatePolicySet({ name: "ok", description: "y".repeat(201), items: [{ leaveTypeId: "t", annualDays: 1 }] }).ok,
    ).toBe(false);
  });

  it("refuses zero items and duplicate types", () => {
    expect(validatePolicySet({ name: "ok", items: [] }).ok).toBe(false);
    const dup = validatePolicySet({
      name: "ok",
      items: [
        { leaveTypeId: "t", annualDays: 1 },
        { leaveTypeId: "t", annualDays: 2 },
      ],
    });
    expect(dup.ok).toBe(false);
    expect(dup.reason).toContain("twice");
  });

  it("refuses allocations outside 0–365 and non-finite numbers", () => {
    expect(validatePolicySet({ name: "ok", items: [{ leaveTypeId: "t", annualDays: 366 }] }).ok).toBe(false);
    expect(validatePolicySet({ name: "ok", items: [{ leaveTypeId: "t", annualDays: -1 }] }).ok).toBe(false);
    expect(validatePolicySet({ name: "ok", items: [{ leaveTypeId: "t", annualDays: Number.NaN }] }).ok).toBe(false);
    // 0 is legal — the tracked-but-unallocated honest zero.
    expect(validatePolicySet({ name: "ok", items: [{ leaveTypeId: "t", annualDays: 0 }] }).ok).toBe(true);
  });
});

describe("assignmentWindowFor", () => {
  it("with no periods the implicit calendar year applies (undefined arg)", () => {
    const res = assignmentWindowFor([], 2027);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowArg).toBeUndefined();
  });

  it("a named period starting in the bucket resolves to its window", () => {
    const periods = [{ id: "p1", name: "FY 2031/32", startDate: "2031-04-01", endDate: "2032-03-31" }];
    const res = assignmentWindowFor(periods, 2031);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowArg).toEqual({ start: "2031-04-01", end: "2032-03-31" });
  });

  it("with named periods but no window in the bucket the assignment is REFUSED (the gap law)", () => {
    const periods = [{ id: "p1", name: "FY 2031/32", startDate: "2031-04-01", endDate: "2032-03-31" }];
    const res = assignmentWindowFor(periods, 2035);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("No named allocation window starts in 2035");
  });
});

describe("assignmentBucketCandidates", () => {
  it("with no periods: this year and the next two implicit calendar years", () => {
    const res = assignmentBucketCandidates([], "2026-11-11");
    expect(res.map((c) => c.bucketYear)).toEqual([2026, 2027, 2028]);
    expect(res[0].label).toContain("Calendar year 2026");
    expect(res.every((c) => !c.named)).toBe(true);
  });

  it("with named periods: only the OPEN windows' buckets, deduped by bucket", () => {
    const periods = [
      { id: "p0", name: "Calendar 2025", startDate: "2025-01-01", endDate: "2025-12-31" }, // closed
      { id: "p1", name: "Calendar 2026", startDate: "2026-01-01", endDate: "2026-12-31" }, // open (running)
      { id: "p2", name: "FY 2027/28", startDate: "2027-04-01", endDate: "2028-03-31" }, // upcoming
    ];
    const res = assignmentBucketCandidates(periods, "2026-11-11");
    expect(res.map((c) => c.bucketYear)).toEqual([2026, 2027]);
    expect(res[1].label).toContain("FY 2027/28");
    expect(res.every((c) => c.named)).toBe(true);
  });
});

describe("policyRowWithAnnualDays", () => {
  it("undefined override passes the row through untouched (the zero-change default)", () => {
    const row = { ...BASE_POLICY, allocationStrategy: "EARNED" };
    expect(policyRowWithAnnualDays(row, undefined)).toBe(row);
    expect(policyRowWithAnnualDays(null, undefined)).toBeNull();
  });

  it("the override rewrites annualDays and a NULL accrualCap follows it (the standing cap rides the set's number)", () => {
    const row = { ...BASE_POLICY, allocationStrategy: "EARNED", accrualCap: null };
    const resolved = resolveLeavePolicy(policyRowWithAnnualDays(row, 30));
    expect(resolved.annualDays).toBe(30);
    expect(resolved.accrualCap).toBe(30); // null cap resolves to annualDays — the SET's days
  });

  it("an EXPLICIT accrualCap survives the override (the admin's own cap)", () => {
    const row = { ...BASE_POLICY, allocationStrategy: "EARNED", accrualCap: 18 };
    const resolved = resolveLeavePolicy(policyRowWithAnnualDays(row, 30));
    expect(resolved.annualDays).toBe(30);
    expect(resolved.accrualCap).toBe(18);
  });

  it("a null ROW with an override is a policy-lite: the set's days + the resolve defaults", () => {
    const resolved = resolveLeavePolicy(policyRowWithAnnualDays(null, 12));
    expect(resolved.annualDays).toBe(12);
    expect(resolved.allocationStrategy).toBe("MANUAL");
    expect(resolved.accrualRounding).toBe("FLOOR_QUARTER");
  });
});

describe("assignedManualGrantDays (LV-03's DOJ pro-rata riding F2.4's rule)", () => {
  const policy = resolveLeavePolicy({ ...BASE_POLICY, prorateForJoiners: true, accrualRounding: "FLOOR_QUARTER" });

  it("a pre-window hire gets the full allocation", () => {
    expect(assignedManualGrantDays(policy, "2026-01-01", "2027-01-01", "2027-12-31")).toBe(policy.annualDays);
  });

  it("a mid-window joiner is pro-rated by calendar days remaining (the F2.4 formula, floor-quarter)", () => {
    // Hire Jul 2 2027 (in-window): remaining = 183 of 365 days.
    const expected = proRateAnnualDays(policy.annualDays, "2027-07-02", "2027-01-01", "2027-12-31", "FLOOR_QUARTER");
    expect(expected).toBe(10); // 20 × 183/365 → 10.0 (floor-quarter)
    expect(assignedManualGrantDays(policy, "2027-07-02", "2027-01-01", "2027-12-31")).toBe(expected);
  });

  it("the type's prorateForJoiners knob OFF means the flat allocation (the same switch ANNUAL_LUMP_SUM reads)", () => {
    const flat = resolveLeavePolicy({ ...BASE_POLICY, prorateForJoiners: false });
    expect(assignedManualGrantDays(flat, "2027-07-02", "2027-01-01", "2027-12-31")).toBe(20);
  });

  it("a hire after the window ends was never entitled to it", () => {
    expect(assignedManualGrantDays(policy, "2028-06-01", "2027-01-01", "2027-12-31")).toBe(0);
  });

  it("no hire date on record = full allocation (the pre-F2.4 facts-free default)", () => {
    expect(assignedManualGrantDays(policy, null, "2027-01-01", "2027-12-31")).toBe(20);
  });
});

describe("assignedManualPreview / joinsMidWindow", () => {
  it("the preview mirrors the grant rule for MANUAL types and passes strategy types through", () => {
    expect(
      assignedManualPreview({ ...BASE_POLICY, prorateForJoiners: true }, 30, "2027-07-02", {
        start: "2027-01-01",
        end: "2027-12-31",
      }),
    ).toBe(15); // 30 × 183/365 → 15.04 → floor-quarter 15
    expect(
      assignedManualPreview({ ...BASE_POLICY, allocationStrategy: "EARNED" }, 30, "2027-07-02", {
        start: "2027-01-01",
        end: "2027-12-31",
      }),
    ).toBe(30); // EARNED: the schedule owns the number — preview is the set's days
  });

  it("joinsMidWindow flags only hires inside the window", () => {
    expect(joinsMidWindow("2027-07-02", { start: "2027-01-01", end: "2027-12-31" })).toBe(true);
    expect(joinsMidWindow("2026-07-02", { start: "2027-01-01", end: "2027-12-31" })).toBe(false);
    expect(joinsMidWindow(null, { start: "2027-01-01", end: "2027-12-31" })).toBe(false);
    expect(joinsMidWindow("2027-07-02", undefined)).toBe(false);
  });
});
