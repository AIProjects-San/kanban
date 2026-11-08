import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P3 (PR-13/PR-B11, F3.1) — the arrears kernel tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 3.
//
// The contract: the reverse-simulation replays the run-creation pipeline
// over the STORED snapshots (paidDays, lopDays, the run's denominator)
// under the CURRENT structure, positive deltas only, honest reasons for
// everything else.
// ---------------------------------------------------------------------------

import { simulateArrearsForSlip, simulateArrearsRun, arrearsAdjustmentLabel } from "@/lib/arrears";
import type { OfferComponent } from "@/lib/offer-math";

const FACTS = {
  payslipId: "ps-1",
  userId: "u-yuki",
  period: "2026-10",
  workingDays: 22,
  paidDays: 22,
  lopDays: 0,
  storedNet: 6_700, // 78,000 + 2,400 annual → 6,700 monthly
};

const OLD_STRUCTURE: OfferComponent[] = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 },
  { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
]; // 80,400 annual → 6,700 monthly (the stored net)

const RAISED_STRUCTURE: OfferComponent[] = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 90_000 }, // +12,000 → +1,000/mo
];

describe("simulateArrearsForSlip", () => {
  it("emits the positive delta when the current structure pays more", () => {
    const d = simulateArrearsForSlip(FACTS, RAISED_STRUCTURE, "ROUND_2DP");
    expect(d.owed).toBe(true);
    expect(d.simulatedNet).toBe(7_500);
    expect(d.delta).toBe(800);
  });

  it("zero difference — nothing owed, reason stated", () => {
    const d = simulateArrearsForSlip(FACTS, OLD_STRUCTURE, "ROUND_2DP");
    expect(d).toMatchObject({ owed: false, delta: 0, reason: "no difference" });
  });

  it("a LOWER current structure is NOT auto-docked (positive deltas only)", () => {
    const lower: OfferComponent[] = [
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 66_000 },
    ];
    const d = simulateArrearsForSlip(FACTS, lower, "ROUND_2DP");
    expect(d.owed).toBe(false);
    expect(d.delta).toBeLessThan(0);
    expect(d.reason).toContain("overpaid");
  });

  it("no active structure — a visible reason, never a zero-simulation lie", () => {
    const d = simulateArrearsForSlip(FACTS, null, "ROUND_2DP");
    expect(d).toMatchObject({ owed: false, delta: 0, reason: "no active salary structure" });
  });

  it("replays the SNAPSHOTTED paidDays (S5 scaling), not today's window", () => {
    const d = simulateArrearsForSlip(
      { ...FACTS, paidDays: 11, storedNet: 3_350 }, // mid-month joiner: half the period, scaled old pay
      RAISED_STRUCTURE,
      "ROUND_2DP",
    );
    // 7,500 × 11/22 = 3,750 vs stored 3,350 (6,700 × 11/22) → +400.
    expect(d.simulatedNet).toBe(3_750);
    expect(d.delta).toBe(400);
  });

  it("replays the SNAPSHOTTED lopDays (F1.4) with the run's denominator", () => {
    const d = simulateArrearsForSlip(
      { ...FACTS, lopDays: 2, storedNet: 6_090.91 }, // the old LOP: 6,700 × 2/22 = 609.09
      RAISED_STRUCTURE,
      "ROUND_2DP",
    );
    // LOP = 7,500 × 2/22 = 681.82 → net 6,818.18 vs stored 6,090.91 → +727.27.
    expect(d.simulatedNet).toBeCloseTo(6_818.18, 2);
    expect(d.delta).toBeCloseTo(727.27, 2);
  });

  it("the comparison baseline is the STORED net — manual edits ride along", () => {
    // The slip was hand-edited up to 8,000 (a bonus line): the arrears
    // compare against what was ACTUALLY paid, not the structure of the day.
    const d = simulateArrearsForSlip({ ...FACTS, storedNet: 8_000 }, RAISED_STRUCTURE, "ROUND_2DP");
    expect(d.delta).toBe(-500);
    expect(d.owed).toBe(false);
  });

  it("the current rounding policy applies to the simulation (S7)", () => {
    const oddFacts = { ...FACTS, storedNet: 6_699.4 };
    const d = simulateArrearsForSlip(oddFacts, RAISED_STRUCTURE, "ROUND_NET_NEAREST");
    // Simulated: 7,500 exactly → no rounding line; delta = 800.6.
    expect(d.delta).toBe(800.6);
  });
});

describe("simulateArrearsRun", () => {
  it("maps per-user structures and separates owed from not-owed", () => {
    const slips = [
      { ...FACTS, payslipId: "ps-1", userId: "u-a" },
      { ...FACTS, payslipId: "ps-2", userId: "u-b" },
      { ...FACTS, payslipId: "ps-3", userId: "u-c" },
    ];
    const byUser = new Map<string, OfferComponent[] | null>([
      ["u-a", RAISED_STRUCTURE],
      ["u-b", OLD_STRUCTURE],
      ["u-c", null],
    ]);
    const { deltas, owed } = simulateArrearsRun(slips, byUser, "ROUND_2DP");
    expect(deltas).toHaveLength(3);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ payslipId: "ps-1", userId: "u-a", delta: 800 });
  });
});

describe("arrearsAdjustmentLabel", () => {
  it("names the source period and slip", () => {
    expect(arrearsAdjustmentLabel("2026-10", "PS-2026-10-001")).toBe("Arrears — 2026-10 (PS-2026-10-001)");
  });
});
