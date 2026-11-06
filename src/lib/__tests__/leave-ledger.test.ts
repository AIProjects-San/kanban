import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F1.2 — pure projection tests for lib/leave-ledger.ts. This is the file
// that pins the ledger↔cache invariants the action tests assert end-to-end:
//   used       == −Σ CONSUME deltas (reversals included)
//   entitled   ==  Σ GRANT
//   carriedOver==  Σ CARRY
//   available  ==  Σ ALL deltas
// ---------------------------------------------------------------------------

import { projectLeaveBalance } from "@/lib/leave-ledger";

describe("projectLeaveBalance", () => {
  it("projects an empty ledger as all zeros", () => {
    expect(projectLeaveBalance([])).toEqual({
      entitled: 0,
      carriedOver: 0,
      used: 0,
      adjustments: 0,
      available: 0,
    });
  });

  it("projects a plain materialized balance (GRANT only)", () => {
    const p = projectLeaveBalance([{ entryType: "GRANT", delta: 20 }]);
    expect(p.entitled).toBe(20);
    expect(p.used).toBe(0);
    expect(p.available).toBe(20);
  });

  it("folds consumption and its reversal into the same `used` sum", () => {
    // Approve 3 days, then cancel: net used 0, available back at 20.
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -3 },
      { entryType: "CONSUME", delta: 3 }, // the isReversal row
    ]);
    expect(p.used).toBe(0);
    expect(p.available).toBe(20);
    expect(p.entitled).toBe(20);
  });

  it("nets multiple consumptions (the QA-1 overdraft shape)", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -12 },
      { entryType: "CONSUME", delta: -6 },
    ]);
    expect(p.used).toBe(18);
    expect(p.available).toBe(2); // a third 5-day approval must be refused
  });

  it("counts CARRY into carriedOver and availability", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CARRY", delta: 5 },
      { entryType: "CONSUME", delta: -8 },
    ]);
    expect(p.carriedOver).toBe(5);
    expect(p.used).toBe(8);
    expect(p.available).toBe(17);
  });

  it("counts EXPIRE against availability but NOT against used", () => {
    // F2.4 shape: 20 granted, 8 used, 3 unused days expired at year end —
    // expiry is an entitlement-side reduction, not consumption.
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -8 },
      { entryType: "EXPIRE", delta: -3 },
    ]);
    expect(p.used).toBe(8);
    expect(p.adjustments).toBe(-3);
    expect(p.available).toBe(9);
  });

  it("counts signed ADJUST rows into adjustments (drift reconciliation)", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -5 },
      { entryType: "ADJUST", delta: -2 }, // legacy used was 7, requests say 5
    ]);
    expect(p.used).toBe(5);
    expect(p.adjustments).toBe(-2);
    expect(p.available).toBe(13); // matches legacy entitled+carried−used
  });

  it("survives half-day fractions exactly (F1.1 semantics)", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -0.5 },
      { entryType: "CONSUME", delta: -0.25 },
      { entryType: "CONSUME", delta: -1 },
    ]);
    expect(p.used).toBe(1.75);
    expect(p.available).toBe(18.25);
  });

  it("kills float dust via 2-decimal rounding", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -0.1 },
      { entryType: "CONSUME", delta: -0.2 },
    ]);
    // 0.1 + 0.2 = 0.30000000000000004 raw; the projection must say 0.3.
    expect(p.used).toBe(0.3);
    expect(p.available).toBe(19.7);
  });

  it("treats an unknown entryType as available-only (forward-only guard)", () => {
    // A future writer adds a type the projection does not know: the days
    // are real, so availability must drop — but no cache column moves.
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "ENCASHMENT", delta: -4 },
    ]);
    expect(p.entitled).toBe(20);
    expect(p.used).toBe(0);
    expect(p.adjustments).toBe(0);
    expect(p.available).toBe(16);
  });

  it("ignores NaN/non-finite deltas defensively", () => {
    const p = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: Number.NaN },
    ]);
    expect(p.used).toBe(0);
    expect(p.available).toBe(20);
  });
});
