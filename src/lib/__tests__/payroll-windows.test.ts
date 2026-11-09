import { describe, expect, it } from "vitest";

import {
  PAYROLL_FREQUENCY_VALUES,
  parsePayrollPeriodKey,
  periodEndMs,
  periodStartMs,
  payrollPeriodLabel,
  resolvePayrollWindow,
  runWindowEnd,
  runWindowStart,
  windowsInYear,
} from "@/lib/payroll-windows";

const iso = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("resolvePayrollWindow", () => {
  it("MONTHLY — calendar month, key unchanged from the pre-P10 format", () => {
    for (const anchor of ["2026-11-01", "2026-11-09", "2026-11-30"]) {
      const w = resolvePayrollWindow("MONTHLY", anchor);
      expect(w?.periodKey).toBe("2026-11");
      expect(w?.start.getTime()).toBe(iso("2026-11-01").getTime());
      expect(w?.end.getTime()).toBe(iso("2026-11-30").getTime());
    }
    expect(resolvePayrollWindow("MONTHLY", "2024-02-15")?.end.getTime()).toBe(iso("2024-02-29").getTime());
    expect(resolvePayrollWindow("MONTHLY", "2026-02-15")?.label).toBe("February 2026");
  });

  it("BIMONTHLY — calendar halves (Frappe's Bimonthly exactly)", () => {
    const a = resolvePayrollWindow("BIMONTHLY", "2026-11-01");
    expect(a?.periodKey).toBe("2026-11-A");
    expect(a?.start.getTime()).toBe(iso("2026-11-01").getTime());
    expect(a?.end.getTime()).toBe(iso("2026-11-15").getTime());

    const aEdge = resolvePayrollWindow("BIMONTHLY", "2026-11-15");
    expect(aEdge?.periodKey).toBe("2026-11-A");

    const b = resolvePayrollWindow("BIMONTHLY", "2026-11-16");
    expect(b?.periodKey).toBe("2026-11-B");
    expect(b?.start.getTime()).toBe(iso("2026-11-16").getTime());
    expect(b?.end.getTime()).toBe(iso("2026-11-30").getTime());

    // Leap February's second half ends on the 29th.
    expect(resolvePayrollWindow("BIMONTHLY", "2024-02-20")?.end.getTime()).toBe(iso("2024-02-29").getTime());
    expect(resolvePayrollWindow("BIMONTHLY", "2026-11-02")?.label).toContain("first half");
  });

  it("WEEKLY — ISO weeks Monday–Sunday, boundary years handled", () => {
    // Nov 9 2026 is a Monday in ISO week 46 (Mon Nov 9 – Sun Nov 15).
    const w = resolvePayrollWindow("WEEKLY", "2026-11-11");
    expect(w?.periodKey).toBe("2026-W46");
    expect(w?.start.getTime()).toBe(iso("2026-11-09").getTime());
    expect(w?.end.getTime()).toBe(iso("2026-11-15").getTime());
    // The anchor's own day-of-week never moves the window.
    expect(resolvePayrollWindow("WEEKLY", "2026-11-15")?.periodKey).toBe("2026-W46");

    // 2026 is a 53-week ISO year: W53 spans Dec 28 2026 – Jan 3 2027.
    const w53 = resolvePayrollWindow("WEEKLY", "2026-12-31");
    expect(w53?.periodKey).toBe("2026-W53");
    expect(w53?.start.getTime()).toBe(iso("2026-12-28").getTime());
    expect(w53?.end.getTime()).toBe(iso("2027-01-03").getTime());
    // … and Jan 1–3 2027 still belong to 2026-W53 (keyed by ISO year 2026).
    expect(resolvePayrollWindow("WEEKLY", "2027-01-01")?.periodKey).toBe("2026-W53");
    // Jan 4 2027 (Monday) starts 2027-W01.
    expect(resolvePayrollWindow("WEEKLY", "2027-01-04")?.periodKey).toBe("2027-W01");
    // Jan 1 2026 (Thursday) sits in 2026-W01, whose Monday is Dec 29 2025.
    const w1 = resolvePayrollWindow("WEEKLY", "2026-01-01");
    expect(w1?.periodKey).toBe("2026-W01");
    expect(w1?.start.getTime()).toBe(iso("2025-12-29").getTime());
    expect(w1?.label).toContain("Week 1, 2026");
  });

  it("FORTNIGHTLY — pairs of ISO weeks; the 53rd week ends the year alone", () => {
    // Nov 9 2026 is in week 46 → fortnight 23 = weeks 45+46 (Nov 2 – Nov 15).
    const f = resolvePayrollWindow("FORTNIGHTLY", "2026-11-09");
    expect(f?.periodKey).toBe("2026-F23");
    expect(f?.start.getTime()).toBe(iso("2026-11-02").getTime());
    expect(f?.end.getTime()).toBe(iso("2026-11-15").getTime());
    // An anchor inside week 45 lands in the same fortnight.
    expect(resolvePayrollWindow("FORTNIGHTLY", "2026-11-03")?.periodKey).toBe("2026-F23");
    // Week 47 starts fortnight 24.
    expect(resolvePayrollWindow("FORTNIGHTLY", "2026-11-16")?.periodKey).toBe("2026-F24");

    // 2026's 53 weeks → F27 is the lone week 53 (Dec 28 – Jan 3).
    const f27 = resolvePayrollWindow("FORTNIGHTLY", "2026-12-30");
    expect(f27?.periodKey).toBe("2026-F27");
    expect(f27?.start.getTime()).toBe(iso("2026-12-28").getTime());
    expect(f27?.end.getTime()).toBe(iso("2027-01-03").getTime());
    // A 52-week year's last fortnight is F26 (two full weeks).
    const f26 = resolvePayrollWindow("FORTNIGHTLY", "2025-12-15");
    expect(f26?.periodKey).toBe("2025-F26");
    expect(dayCount(f26)).toBe(14);
  });

  it("DAILY — the single anchor day", () => {
    const w = resolvePayrollWindow("DAILY", "2026-11-09");
    expect(w?.periodKey).toBe("2026-11-09");
    expect(w?.start.getTime()).toBe(iso("2026-11-09").getTime());
    expect(w?.end.getTime()).toBe(iso("2026-11-09").getTime());
    expect(w?.label).toContain("Nov 9, 2026");
  });

  it("QUARTERLY and ANNUAL — calendar quarters and years", () => {
    const q4 = resolvePayrollWindow("QUARTERLY", "2026-11-09");
    expect(q4?.periodKey).toBe("2026-Q4");
    expect(q4?.start.getTime()).toBe(iso("2026-10-01").getTime());
    expect(q4?.end.getTime()).toBe(iso("2026-12-31").getTime());
    expect(resolvePayrollWindow("QUARTERLY", "2026-01-31")?.periodKey).toBe("2026-Q1");

    const annual = resolvePayrollWindow("ANNUAL", "2026-07-04");
    expect(annual?.periodKey).toBe("2026");
    expect(annual?.start.getTime()).toBe(iso("2026-01-01").getTime());
    expect(annual?.end.getTime()).toBe(iso("2026-12-31").getTime());
  });

  it("accepts Date anchors (normalized to UTC midnight) and rejects garbage", () => {
    expect(resolvePayrollWindow("MONTHLY", new Date("2026-11-09T15:42:00Z"))?.periodKey).toBe("2026-11");
    expect(resolvePayrollWindow("DAILY", new Date("2026-11-09T23:59:59Z"))?.periodKey).toBe("2026-11-09");
    expect(resolvePayrollWindow("MONTHLY", "not-a-date")).toBeNull();
    expect(resolvePayrollWindow("DAILY", "2026-02-30")).toBeNull();
    expect(resolvePayrollWindow("WEEKLY", "")).toBeNull();
  });

  it("the seven cadence keys for one anchor month are mutually distinct", () => {
    const keys = [
      resolvePayrollWindow("MONTHLY", "2026-11-09"),
      resolvePayrollWindow("BIMONTHLY", "2026-11-09"),
      resolvePayrollWindow("WEEKLY", "2026-11-09"),
      resolvePayrollWindow("FORTNIGHTLY", "2026-11-09"),
      resolvePayrollWindow("DAILY", "2026-11-09"),
      resolvePayrollWindow("QUARTERLY", "2026-11-09"),
      resolvePayrollWindow("ANNUAL", "2026-11-09"),
    ].map((w) => w?.periodKey);
    expect(new Set(keys).size).toBe(7);
  });
});

describe("parsePayrollPeriodKey (the inverse)", () => {
  it("round-trips every cadence's key to the same window", () => {
    for (const frequency of PAYROLL_FREQUENCY_VALUES) {
      const w = resolvePayrollWindow(frequency, "2026-11-09");
      expect(w, frequency).not.toBeNull();
      const parsed = parsePayrollPeriodKey(w!.periodKey);
      expect(parsed, frequency).not.toBeNull();
      expect(parsed!.frequency).toBe(frequency);
      expect(parsed!.start.getTime()).toBe(w!.start.getTime());
      expect(parsed!.end.getTime()).toBe(w!.end.getTime());
      expect(parsed!.label).toBe(w!.label);
    }
  });

  it("parses pre-P10 monthly keys (the migration backfill path)", () => {
    const w = parsePayrollPeriodKey("2026-11");
    expect(w?.frequency).toBe("MONTHLY");
    expect(w?.start.getTime()).toBe(iso("2026-11-01").getTime());
    expect(w?.end.getTime()).toBe(iso("2026-11-30").getTime());
  });

  it("rejects malformed and out-of-range keys with null", () => {
    for (const bad of [
      "2026-13", // no month 13
      "2026-00",
      "2026-W00",
      "2026-W54", // 2026 has 53 weeks
      "2025-W53", // 2025 has 52
      "2026-F28", // 2026 has 27 fortnights
      "2026-F00",
      "2026-Q0",
      "2026-Q5",
      "2026-11-C", // halves are A/B only
      "2026-11-a", // lowercase half
      "2026-02-30", // impossible date
      "202-11", "abcd", "", "2026-W1", "2026-F1",
    ]) {
      expect(parsePayrollPeriodKey(bad), bad).toBeNull();
    }
  });

  it("trims surrounding whitespace like the stored-key readers do", () => {
    expect(parsePayrollPeriodKey(" 2026-11 ")?.periodKey).toBe("2026-11");
  });
});

describe("periodStartMs / periodEndMs — the comparison primitives", () => {
  it("orders windows by real time, not lexicographic key order", () => {
    // Lexicographically "2026-11" < "2026-W45", and "2026-12" < "2026-W45" —
    // but W45 (Nov 2) sits BETWEEN November and December in real time.
    expect(periodStartMs("2026-11")).toBeLessThan(periodStartMs("2026-W45")!);
    expect(periodStartMs("2026-W45")!).toBeLessThan(periodStartMs("2026-12")!);
    // Weekly keys of a 53-week year stay inside their ISO year.
    expect(periodStartMs("2026-W53")!).toBeLessThan(periodStartMs("2027-W01")!);
    // The lexicographic trap this replaces: as STRINGS "2026-W45" sorts
    // AFTER "2026-12" ('W' > '1'), even though week 45 is a month earlier.
    expect("2026-W45" > "2026-12").toBe(true);
  });

  it("returns null for unparseable keys (never a fake January)", () => {
    expect(periodStartMs("junk")).toBeNull();
    expect(periodEndMs("")).toBeNull();
  });

  it("end instants are inclusive window ends", () => {
    expect(periodEndMs("2026-11")).toBe(iso("2026-11-30").getTime());
    expect(periodEndMs("2026-W46")).toBe(iso("2026-11-15").getTime());
    expect(periodEndMs("2026-11-09")).toBe(iso("2026-11-09").getTime());
  });
});

describe("windowsInYear — the per-cadence amount divisor", () => {
  it("divides the calendar as documented", () => {
    expect(windowsInYear("MONTHLY", 2026)).toBe(12);
    expect(windowsInYear("BIMONTHLY", 2026)).toBe(24);
    expect(windowsInYear("QUARTERLY", 2026)).toBe(4);
    expect(windowsInYear("ANNUAL", 2026)).toBe(1);
    expect(windowsInYear("DAILY", 2026)).toBe(365);
    expect(windowsInYear("DAILY", 2024)).toBe(366); // leap
  });

  it("knows the 52- and 53-week ISO years", () => {
    expect(windowsInYear("WEEKLY", 2025)).toBe(52);
    expect(windowsInYear("WEEKLY", 2026)).toBe(53);
    expect(windowsInYear("WEEKLY", 2020)).toBe(53);
    expect(windowsInYear("FORTNIGHTLY", 2025)).toBe(26);
    expect(windowsInYear("FORTNIGHTLY", 2026)).toBe(27);
  });
});

describe("labels and run-row fallbacks", () => {
  it("labels every cadence and falls back to the raw key", () => {
    expect(payrollPeriodLabel("2026-11")).toBe("November 2026");
    expect(payrollPeriodLabel("2026-11-A")).toContain("first half");
    expect(payrollPeriodLabel("2026-W46")).toContain("Week 46, 2026");
    expect(payrollPeriodLabel("2026-F23")).toContain("Fortnight 23, 2026");
    expect(payrollPeriodLabel("2026-Q4")).toContain("Q4 2026");
    expect(payrollPeriodLabel("2026")).toContain("2026");
    expect(payrollPeriodLabel("mystery-key")).toBe("mystery-key");
  });

  it("runWindowStart/runWindowEnd prefer stored dates and fall back to the parsed key", () => {
    expect(runWindowEnd("2026-11", iso("2026-11-30"))?.getTime()).toBe(iso("2026-11-30").getTime());
    // A null/missing endDate (pre-P10 rows) parses the monthly key.
    expect(runWindowEnd("2026-11", null)?.getTime()).toBe(iso("2026-11-30").getTime());
    expect(runWindowEnd("2026-11")?.getTime()).toBe(iso("2026-11-30").getTime());
    // ISO strings (serialized API payloads) work too.
    expect(runWindowStart("2026-W46", "2026-11-09T00:00:00.000Z")?.getTime()).toBe(iso("2026-11-09").getTime());
    // An unparseable key with no stored date → null.
    expect(runWindowEnd("junk", null)).toBeNull();
  });
});

function dayCount(w: { start: Date; end: Date } | null): number {
  return Math.round((w!.end.getTime() - w!.start.getTime()) / 86_400_000) + 1;
}
