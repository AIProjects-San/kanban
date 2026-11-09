import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// AT-B02/B03 (S2) — pure-kernel tests for the attendance timing facts
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
// Clock-free, I/O-free: every case is a table row, no mocks anywhere.
// ---------------------------------------------------------------------------

import {
  parseHmToMinutes,
  deriveAttendanceTiming,
  describeAttendanceTiming,
  formatMinutes,
} from "../attendance-flags";

describe("parseHmToMinutes", () => {
  it("parses HH:MM 24-hour strings to minutes since midnight", () => {
    expect(parseHmToMinutes("00:00")).toBe(0);
    expect(parseHmToMinutes("09:00")).toBe(540);
    expect(parseHmToMinutes("17:30")).toBe(1050);
    expect(parseHmToMinutes("23:59")).toBe(1439);
    expect(parseHmToMinutes(" 09:05 ")).toBe(545); // trimmed
  });
  it("rejects malformed / absent values with null (no throw)", () => {
    for (const bad of ["9:00", "24:00", "09:60", "09-00", "", "0900", null, undefined]) {
      expect(parseHmToMinutes(bad as string | null)).toBeNull();
    }
  });
});

describe("deriveAttendanceTiming — the fact matrix", () => {
  const day = { dayStart: "09:00", dayEnd: "17:30" };

  it("on-time full day: zero flags, 8.5 hours, no overtime", () => {
    expect(deriveAttendanceTiming({ inTime: "09:00", outTime: "17:30", ...day }))
      .toEqual({ lateMinutes: 0, earlyMinutes: 0, workingHours: 8.5, overtimeMinutes: 0 });
  });

  it("late + early the same day (the classic squeeze)", () => {
    expect(deriveAttendanceTiming({ inTime: "09:25", outTime: "17:10", ...day }))
      .toEqual({ lateMinutes: 25, earlyMinutes: 20, workingHours: 7.75, overtimeMinutes: 0 });
  });

  it("in only: late flag, others null (unknown, not zero)", () => {
    expect(deriveAttendanceTiming({ inTime: "10:00", outTime: null, ...day }))
      .toEqual({ lateMinutes: 60, earlyMinutes: null, workingHours: null, overtimeMinutes: null });
  });

  it("out only: early flag + hours null; overtime derivable from out alone", () => {
    expect(deriveAttendanceTiming({ inTime: null, outTime: "15:00", ...day }))
      .toEqual({ lateMinutes: null, earlyMinutes: 150, workingHours: null, overtimeMinutes: 0 });
    expect(deriveAttendanceTiming({ inTime: null, outTime: "19:00", ...day }))
      .toEqual({ lateMinutes: null, earlyMinutes: 0, workingHours: null, overtimeMinutes: 90 });
  });

  it("no times: everything null", () => {
    expect(deriveAttendanceTiming({ inTime: null, outTime: null, ...day }))
      .toEqual({ lateMinutes: null, earlyMinutes: null, workingHours: null, overtimeMinutes: null });
  });

  it("early arrival never produces a negative late flag (clamped at 0)", () => {
    expect(deriveAttendanceTiming({ inTime: "08:30", outTime: "18:00", ...day }))
      .toEqual({ lateMinutes: 0, earlyMinutes: 0, workingHours: 9.5, overtimeMinutes: 30 });
  });

  it("P9 — overtime accumulates past the day end, clamped at 0 before it", () => {
    expect(deriveAttendanceTiming({ inTime: "09:00", outTime: "19:30", ...day }).overtimeMinutes)
      .toBe(120);
    expect(deriveAttendanceTiming({ inTime: "10:00", outTime: "17:00", ...day }).overtimeMinutes)
      .toBe(0);
  });

  it("fractional hours round to 2 decimals", () => {
    // 09:07 → 17:23 = 496 min = 8.2666… h → 8.27.
    expect(deriveAttendanceTiming({ inTime: "09:07", outTime: "17:23", ...day }).workingHours)
      .toBe(8.27);
  });

  it("out <= in yields null hours (defensive: the form rejects it, the kernel must not lie)", () => {
    expect(deriveAttendanceTiming({ inTime: "17:30", outTime: "09:00", ...day }).workingHours)
      .toBeNull();
  });

  it("a malformed reference day disables the dependent fact instead of throwing", () => {
    expect(deriveAttendanceTiming({ inTime: "10:00", outTime: "16:00", dayStart: "nine", dayEnd: "17:30" }))
      .toEqual({ lateMinutes: null, earlyMinutes: 90, workingHours: 6, overtimeMinutes: 0 });
    expect(deriveAttendanceTiming({ inTime: "10:00", outTime: "16:00", dayStart: "09:00", dayEnd: "" }))
      .toEqual({ lateMinutes: 60, earlyMinutes: null, workingHours: 6, overtimeMinutes: null });
  });
});

describe("rendering helpers", () => {
  it("formatMinutes renders hours/minutes compactly", () => {
    expect(formatMinutes(25)).toBe("25m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(95)).toBe("1h 35m");
  });

  it("describeAttendanceTiming lists only facts that actually happened", () => {
    expect(describeAttendanceTiming({ lateMinutes: 0, earlyMinutes: 0, workingHours: 8.5, overtimeMinutes: 0 }))
      .toBe("8h 30m worked");
    expect(describeAttendanceTiming({ lateMinutes: 25, earlyMinutes: null, workingHours: null, overtimeMinutes: null }))
      .toBe("Late 25m");
    expect(describeAttendanceTiming({ lateMinutes: 25, earlyMinutes: 10, workingHours: 7.75, overtimeMinutes: 0 }))
      .toBe("Late 25m · Early 10m · 7h 45m worked");
    expect(describeAttendanceTiming({ lateMinutes: null, earlyMinutes: null, workingHours: null, overtimeMinutes: null }))
      .toBe("");
    expect(describeAttendanceTiming({ lateMinutes: 0, earlyMinutes: 0, workingHours: 10.5, overtimeMinutes: 120 }))
      .toBe("10h 30m worked · OT 2h");
  });
});
