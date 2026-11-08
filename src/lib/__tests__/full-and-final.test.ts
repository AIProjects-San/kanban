import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.1 — full-and-final statement math (docs/Fernly_HR_Payroll_Enhancement_
// Plan.md §7.2 F2.1). Pure kernel rule matrix: salary payables from OPEN
// runs only, encashment of paid types at the structure daily rate,
// advance-leave recovery, unpaid/no-structure honesty notes, exact-sum
// totals (the acceptance criterion "statement math unit tests").
// ---------------------------------------------------------------------------

import {
  computeFullAndFinal,
  dailyLeaveRate,
  parseFnFLines,
  type FnFInput,
  type FnFLeaveAccount,
  type FnFOpenRun,
} from "../full-and-final";

const BASE: FnFInput = {
  asOf: "2026-11-08",
  lastWorkingDay: "2026-11-07",
  monthlyGross: 5_200,
  ratePeriod: "2026-11",
  rateWorkingDays: 21,
  openRuns: [],
  leaveAccounts: [],
};

function account(partial: Partial<FnFLeaveAccount>): FnFLeaveAccount {
  return { leaveTypeId: "lt-1", name: "Annual", paid: true, available: 0, ...partial };
}

function run(partial: Partial<FnFOpenRun>): FnFOpenRun {
  return { period: "2026-11", payslipNet: null, ...partial };
}

describe("dailyLeaveRate", () => {
  it("divides the monthly gross by the holiday-aware working days, rounded once", () => {
    // 5,200 / 21 = 247.619… → 247.62
    expect(dailyLeaveRate(5_200, 21)).toBe(247.62);
  });

  it("is 0 without a structure (null) — the notes explain why", () => {
    expect(dailyLeaveRate(null, 21)).toBe(0);
  });

  it("is 0 for a non-positive denominator (never NaN / Infinity)", () => {
    expect(dailyLeaveRate(5_200, 0)).toBe(0);
    expect(dailyLeaveRate(5_200, -3)).toBe(0);
    expect(dailyLeaveRate(0, 21)).toBe(0);
  });
});

describe("computeFullAndFinal — salary payables (OPEN runs only)", () => {
  it("lists the OPEN run's payslip net as a payable line", () => {
    const out = computeFullAndFinal({ ...BASE, openRuns: [run({ payslipNet: 4_980.75 })] });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].kind).toBe("SALARY");
    expect(out.lines[0].label).toContain("2026-11");
    expect(out.lines[0].amount).toBe(4_980.75);
    expect(out.payableTotal).toBe(4_980.75);
    expect(out.netPayable).toBe(4_980.75);
  });

  it("contributes one line per OPEN run holding a payslip", () => {
    const out = computeFullAndFinal({
      ...BASE,
      openRuns: [run({ period: "2026-10", payslipNet: 100 }), run({ period: "2026-11", payslipNet: 200.5 })],
    });
    expect(out.lines.filter((l) => l.kind === "SALARY")).toHaveLength(2);
    expect(out.payableTotal).toBe(300.5);
  });

  it("an OPEN run WITHOUT a payslip yields a note, not a silent zero", () => {
    const out = computeFullAndFinal({ ...BASE, openRuns: [run({ payslipNet: null })] });
    expect(out.lines).toHaveLength(0);
    expect(out.notes.some((n) => n.includes("No payslip") && n.includes("2026-11"))).toBe(true);
  });

  it("a zero-net payslip adds no line and no note", () => {
    const out = computeFullAndFinal({ ...BASE, openRuns: [run({ payslipNet: 0 })] });
    expect(out.lines).toHaveLength(0);
    expect(out.notes).toHaveLength(0);
  });
});

describe("computeFullAndFinal — encashment & advance-leave recovery", () => {
  it("encashes a positive paid balance at the daily rate", () => {
    // 4 days × 247.62 = 990.48
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: 4 })],
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].kind).toBe("ENCASHMENT");
    expect(out.lines[0].days).toBe(4);
    expect(out.lines[0].rate).toBe(247.62);
    expect(out.lines[0].amount).toBe(990.48);
    expect(out.payableTotal).toBe(990.48);
    expect(out.receivableTotal).toBe(0);
  });

  it("recovers a negative balance (advance leave) as a receivable", () => {
    // 2 days owed × 247.62 = 495.24 receivable
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ name: "Advance Annual", available: -2 })],
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].kind).toBe("ADVANCE_LEAVE");
    expect(out.lines[0].days).toBe(2);
    expect(out.lines[0].amount).toBe(-495.24);
    expect(out.receivableTotal).toBe(495.24);
    expect(out.netPayable).toBe(-495.24);
  });

  it("half-day fractions carry through the line math", () => {
    // 4.5 × 247.62 = 1,114.29
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: 4.5 })],
    });
    expect(out.lines[0].days).toBe(4.5);
    expect(out.lines[0].amount).toBe(1_114.29);
  });

  it("zero balances produce no lines", () => {
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: 0 }), account({ name: "Sick", leaveTypeId: "lt-2", available: 0 })],
    });
    expect(out.lines).toHaveLength(0);
  });

  it("unpaid types are excluded with an explicit note", () => {
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ name: "Unpaid", paid: false, available: 6 })],
    });
    expect(out.lines).toHaveLength(0);
    expect(out.notes.some((n) => n.includes("Unpaid") && n.includes("no cash value"))).toBe(true);
  });

  it("without a structure the rate is 0.00 but the day counts still list", () => {
    const out = computeFullAndFinal({
      ...BASE,
      monthlyGross: null,
      leaveAccounts: [account({ available: 15 })],
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].rate).toBe(0);
    expect(out.lines[0].amount).toBe(0);
    expect(out.lines[0].days).toBe(15);
    expect(out.notes.some((n) => n.includes("No active salary structure"))).toBe(true);
  });

  it("mixed types settle into exact payable / receivable / net totals", () => {
    const out = computeFullAndFinal({
      ...BASE,
      openRuns: [run({ payslipNet: 4_980.75 })],
      leaveAccounts: [
        account({ name: "Annual", available: 4 }),
        account({ name: "Advance Annual", leaveTypeId: "lt-2", available: -2 }),
      ],
    });
    // payable 4,980.75 + 990.48 = 5,971.23; receivable 495.24; net 5,475.99.
    expect(out.payableTotal).toBe(5_971.23);
    expect(out.receivableTotal).toBe(495.24);
    expect(out.netPayable).toBe(5_475.99);
  });

  it("a receivable heavier than the payables yields a NEGATIVE net (owed back)", () => {
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: -2 })],
    });
    expect(out.netPayable).toBe(-495.24);
    expect(out.notes).toHaveLength(0); // negative net is honest, not note-worthy
  });
});

describe("computeFullAndFinal — degenerate inputs", () => {
  it("no last working day → no lines, one guiding note, zero rate", () => {
    const out = computeFullAndFinal({
      ...BASE,
      lastWorkingDay: null,
      openRuns: [run({ payslipNet: 100 })],
      leaveAccounts: [account({ available: 4 })],
    });
    expect(out.lines).toHaveLength(0);
    expect(out.payableTotal).toBe(0);
    expect(out.netPayable).toBe(0);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain("last working day");
    expect(out.rateBasis.dailyRate).toBe(0);
  });

  it("non-finite availability is treated as zero (defensive)", () => {
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: Number.NaN })],
    });
    expect(out.lines).toHaveLength(0);
  });

  it("carries the rate basis through for the UI", () => {
    const out = computeFullAndFinal({ ...BASE, leaveAccounts: [account({ available: 1 })] });
    expect(out.rateBasis).toEqual({
      period: "2026-11",
      workingDays: 21,
      monthlyGross: 5_200,
      dailyRate: 247.62,
    });
    expect(out.asOf).toBe("2026-11-08");
  });
});

describe("parseFnFLines", () => {
  it("round-trips the computed lines", () => {
    const out = computeFullAndFinal({
      ...BASE,
      leaveAccounts: [account({ available: 4 })],
      openRuns: [run({ payslipNet: 100 })],
    });
    expect(parseFnFLines(JSON.stringify(out.lines))).toEqual(out.lines);
  });

  it("rejects garbage without throwing", () => {
    expect(parseFnFLines("not json")).toEqual([]);
    expect(parseFnFLines("{}")).toEqual([]);
    expect(parseFnFLines('[{"kind":1}]')).toEqual([]);
    expect(parseFnFLines("[]")).toEqual([]);
  });
});
