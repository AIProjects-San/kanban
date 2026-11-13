import { describe, expect, it } from "vitest";

import {
  componentYtdAmount,
  computeRunningAggregates,
  type AggregateSlip,
} from "@/lib/payroll/payslip-aggregates";

const ms = (s: string) => new Date(`${s}T00:00:00.000Z`).getTime();

function slip(over: Partial<AggregateSlip> & Pick<AggregateSlip, "id">): AggregateSlip {
  return {
    userId: "u-1",
    slipNo: `PS-${over.id}`,
    gross: 100,
    net: 90,
    withholdStatus: "",
    earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 100 }]),
    deductions: "[]",
    windowEndMs: ms("2026-11-30"),
    ...over,
  };
}

describe("computeRunningAggregates (P11 / PR-B09)", () => {
  it("accumulates YTD gross/net per year and resets with the calendar year", () => {
    const agg = computeRunningAggregates([
      slip({ id: "a", gross: 100, net: 90, windowEndMs: ms("2026-10-31") }),
      slip({ id: "b", gross: 200, net: 180, windowEndMs: ms("2026-11-30") }),
      slip({ id: "c", gross: 50, net: 45, windowEndMs: ms("2027-01-31") }),
    ]);
    expect(agg.get("a")).toMatchObject({ ytdNet: 90, ytdGross: 100 });
    expect(agg.get("b")).toMatchObject({ ytdNet: 270, ytdGross: 300 });
    // New year: the January 2027 slip starts from zero.
    expect(agg.get("c")).toMatchObject({ ytdNet: 45, ytdGross: 50 });
  });

  it("resets MTD with the calendar month (window-end attribution)", () => {
    const agg = computeRunningAggregates([
      slip({ id: "oct", gross: 100, net: 90, windowEndMs: ms("2026-10-31") }),
      slip({ id: "nov1", gross: 100, net: 90, windowEndMs: ms("2026-11-08") }), // a weekly run
      slip({ id: "nov2", gross: 100, net: 90, windowEndMs: ms("2026-11-30") }), // the month run
    ]);
    expect(agg.get("oct")?.mtdNet).toBe(90);
    expect(agg.get("nov1")?.mtdNet).toBe(90);
    expect(agg.get("nov2")?.mtdNet).toBe(180); // both November windows sum
  });

  it("orders by window END, not period-string order (mixed cadences)", () => {
    const agg = computeRunningAggregates([
      // As strings "2026-W45" sorts AFTER "2026-12" — the kernel must not care.
      slip({ id: "dec", gross: 100, net: 90, windowEndMs: ms("2026-12-31") }),
      slip({ id: "w45", gross: 100, net: 90, windowEndMs: ms("2026-11-08") }),
    ]);
    expect(agg.get("w45")?.ytdNet).toBe(90);
    expect(agg.get("dec")?.ytdNet).toBe(180);
  });

  it("never accumulates WITHHELD or RELEASED slips — they carry the last paid values", () => {
    const agg = computeRunningAggregates([
      slip({ id: "oct", gross: 100, net: 90, windowEndMs: ms("2026-10-31") }),
      slip({ id: "held", gross: 100, net: 90, withholdStatus: "WITHHELD", windowEndMs: ms("2026-11-30") }),
      slip({ id: "rel", gross: 100, net: 90, withholdStatus: "RELEASED", windowEndMs: ms("2026-12-31") }),
      slip({ id: "jan27", gross: 100, net: 90, windowEndMs: ms("2027-01-31") }),
    ]);
    // Held: the October values carry forward (its own net is NOT added).
    expect(agg.get("held")).toMatchObject({ ytdNet: 90, ytdGross: 100, mtdNet: 0 });
    expect(agg.get("rel")).toMatchObject({ ytdNet: 90, ytdGross: 100, mtdNet: 0 });
    // January starts clean.
    expect(agg.get("jan27")?.ytdNet).toBe(90);
  });

  it("merges component YTD by side+key across slips and skips statistical lines", () => {
    const agg = computeRunningAggregates([
      slip({
        id: "m10",
        windowEndMs: ms("2026-10-31"),
        gross: 300,
        net: 250,
        earnings: JSON.stringify([
          { key: "basic", label: "Basic Salary", amount: 250 },
          { key: "transport", label: "Transport", amount: 50 },
        ]),
        deductions: JSON.stringify([{ key: "lop", label: "Loss of pay (1 day)", amount: 50 }]),
      }),
      slip({
        id: "m11",
        windowEndMs: ms("2026-11-30"),
        gross: 300,
        net: 250,
        earnings: JSON.stringify([
          { key: "basic", label: "Basic Salary", amount: 250 },
          // Statistical rows ride payslips but are not money (S8).
          { key: "package_note", label: "Package", amount: 999, statistical: true },
        ]),
        deductions: JSON.stringify([{ key: "lop", label: "Loss of pay (1 day)", amount: 50 }]),
      }),
    ]);
    const rows = agg.get("m11")?.componentYtd ?? [];
    expect(rows.find((r) => r.key === "basic")).toMatchObject({ side: "EARNING", amount: 500 });
    expect(rows.find((r) => r.key === "lop")).toMatchObject({ side: "DEDUCTION", amount: 100 });
    expect(rows.find((r) => r.key === "transport")).toMatchObject({ amount: 50 });
    expect(rows.find((r) => r.key === "package_note")).toBeUndefined();
    // October's snapshot has only its own components.
    expect((agg.get("m10")?.componentYtd ?? []).length).toBe(3);
    // componentYtdAmount helper: side-aware lookup.
    expect(componentYtdAmount(agg.get("m11"), "EARNING", "basic")).toBe(500);
    expect(componentYtdAmount(agg.get("m11"), "DEDUCTION", "basic")).toBe(0);
    expect(componentYtdAmount(undefined, "EARNING", "basic")).toBe(0);
  });

  it("keeps users independent (no cross-user leakage)", () => {
    const agg = computeRunningAggregates([
      slip({ id: "u2", userId: "u-2", windowEndMs: ms("2026-10-31") }),
      slip({ id: "u1", userId: "u-1", windowEndMs: ms("2026-11-30") }),
    ]);
    expect(agg.get("u1")?.ytdNet).toBe(90);
    expect(agg.get("u2")?.ytdNet).toBe(90);
  });

  it("ties break by slipNo and the input array is never mutated", () => {
    const input = [
      slip({ id: "b", slipNo: "PS-B", windowEndMs: ms("2026-11-30") }),
      slip({ id: "a", slipNo: "PS-A", windowEndMs: ms("2026-11-30") }),
    ];
    const order = input.map((s) => s.id).join(",");
    const agg = computeRunningAggregates(input);
    expect(input.map((s) => s.id).join(",")).toBe(order);
    expect(agg.get("a")?.ytdNet).toBe(90);
    expect(agg.get("b")?.ytdNet).toBe(180);
  });
});

describe("computeRunningAggregates — P16 fiscal-year basis (PR-11)", () => {
  it("resets YTD at the fiscal boundary (April start): Dec 2026 → Jan 2027 is ONE fiscal year", () => {
    const agg = computeRunningAggregates(
      [
        slip({ id: "dec26", gross: 100, net: 90, windowEndMs: ms("2026-12-31") }),
        slip({ id: "jan27", gross: 100, net: 90, windowEndMs: ms("2027-01-31") }),
        slip({ id: "apr27", gross: 100, net: 90, windowEndMs: ms("2027-04-30") }),
      ],
      { fiscalYearStartMonth: 4 },
    );
    // Dec 2026 and Jan 2027 both sit inside FY 2026/27 (Apr 2026 – Mar 2027).
    expect(agg.get("dec26")?.ytdNet).toBe(90);
    expect(agg.get("jan27")?.ytdNet).toBe(180);
    // April 2027 starts FY 2027/28: the reset is at the fiscal boundary.
    expect(agg.get("apr27")?.ytdNet).toBe(90);
  });

  it("startMonth 1 (or omitted) keeps the calendar-year behavior byte-identical", () => {
    const slips = [
      slip({ id: "dec26", windowEndMs: ms("2026-12-31") }),
      slip({ id: "jan27", windowEndMs: ms("2027-01-31") }),
    ];
    const cal = computeRunningAggregates(slips);
    const fy1 = computeRunningAggregates(slips, { fiscalYearStartMonth: 1 });
    expect(cal.get("jan27")?.ytdNet).toBe(90);
    expect(fy1.get("jan27")?.ytdNet).toBe(cal.get("jan27")?.ytdNet);
    expect(fy1.get("dec26")?.ytdGross).toBe(cal.get("dec26")?.ytdGross);
  });

  it("MTD stays the calendar month regardless of the fiscal basis", () => {
    const agg = computeRunningAggregates(
      [
        slip({ id: "mar", windowEndMs: ms("2027-03-31") }),
        slip({ id: "apr", windowEndMs: ms("2027-04-30") }),
      ],
      { fiscalYearStartMonth: 4 },
    );
    expect(agg.get("apr")?.mtdNet).toBe(90); // April alone — MTD is calendar
    expect(agg.get("apr")?.ytdNet).toBe(90); // and the fiscal year reset too
  });

  it("component YTD follows the fiscal year key (merge across the calendar boundary)", () => {
    const agg = computeRunningAggregates(
      [
        slip({
          id: "dec26",
          windowEndMs: ms("2026-12-31"),
          earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 250 }]),
          deductions: "[]",
        }),
        slip({
          id: "feb27",
          windowEndMs: ms("2027-02-28"),
          earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 250 }]),
          deductions: "[]",
        }),
      ],
      { fiscalYearStartMonth: 4 },
    );
    expect(agg.get("feb27")?.componentYtd.find((r) => r.key === "basic")?.amount).toBe(500);
  });
});

describe("computeRunningAggregates — P16 opening balances (PR-04)", () => {
  const opening = {
    userId: "u-1",
    fiscalStartYear: 2026,
    components: [
      { key: "basic", label: "Basic (prior employer)", side: "EARNING" as const, amount: 39_000 },
      { key: "student_loan", label: "Student loan", side: "DEDUCTION" as const, amount: 1_300 },
    ],
  };

  it("seeds the fiscal year: gross from earnings, net = earnings − deductions", () => {
    const agg = computeRunningAggregates(
      [slip({ id: "nov", gross: 6_500, net: 6_000, windowEndMs: ms("2026-11-30") })],
      { openings: [opening] },
    );
    expect(agg.get("nov")?.ytdGross).toBe(45_500); // 39,000 + 6,500
    expect(agg.get("nov")?.ytdNet).toBe(43_700); // 39,000 − 1,300 + 6,000
    // MTD is untouched by openings (this month only).
    expect(agg.get("nov")?.mtdNet).toBe(6_000);
    // Component rows carry the opening alongside the slip's own lines.
    expect(agg.get("nov")?.componentYtd.find((r) => r.key === "basic")?.amount).toBe(39_000 + 100);
  });

  it("does not leak into other fiscal years or other users", () => {
    const agg = computeRunningAggregates(
      [
        slip({ id: "fy26", windowEndMs: ms("2026-11-30") }),
        slip({ id: "fy27", windowEndMs: ms("2027-05-31") }),
        slip({ id: "other", userId: "u-2", windowEndMs: ms("2026-11-30") }),
      ],
      { openings: [opening] },
    );
    expect(agg.get("fy26")?.ytdGross).toBe(39_100);
    expect(agg.get("fy27")?.ytdGross).toBe(100); // new fiscal year starts clean
    expect(agg.get("other")?.ytdGross).toBe(100); // another user, never seeded
  });

  it("a WITHHELD first slip still carries the opening forward (history, not pay)", () => {
    const agg = computeRunningAggregates(
      [slip({ id: "held", withholdStatus: "WITHHELD", windowEndMs: ms("2026-11-30") })],
      { openings: [opening] },
    );
    expect(agg.get("held")?.ytdGross).toBe(39_000); // carried, its own gross not added
    expect(agg.get("held")?.ytdNet).toBe(37_700);
  });

  it("opening rows merge by side+key with slip lines (same discipline as lines)", () => {
    const agg = computeRunningAggregates(
      [
        slip({
          id: "nov",
          windowEndMs: ms("2026-11-30"),
          earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 100 }]),
          deductions: JSON.stringify([{ key: "student_loan", label: "SL", amount: 50 }]),
        }),
      ],
      { openings: [opening] },
    );
    expect(agg.get("nov")?.componentYtd.find((r) => r.key === "basic")?.amount).toBe(39_100);
    expect(agg.get("nov")?.componentYtd.find((r) => r.key === "student_loan")?.amount).toBe(1_350);
  });
});
