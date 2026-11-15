import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G4 — the shift + roster kernel tests: clock parsing, the overnight
// crossing, span/break math, the validation twin, the roster conflict
// predicate and the absence-detection candidates.
// ---------------------------------------------------------------------------

import {
  parseClockTime,
  isValidClockTime,
  shiftIsOvernight,
  shiftDurationMinutes,
  shiftExpectedHours,
  isValidShiftInput,
  findRosterConflict,
  absenceCandidates,
} from "../shifts";

describe("clock parsing", () => {
  it("parses HH:mm (loose single-digit hours tolerated at the parse level)", () => {
    expect(parseClockTime("09:00")).toBe(540);
    expect(parseClockTime("17:30")).toBe(1050);
    expect(parseClockTime("00:00")).toBe(0);
    expect(parseClockTime("23:59")).toBe(1439);
    expect(parseClockTime("9:00")).toBe(540);
  });

  it("refuses garbage", () => {
    expect(parseClockTime("24:00")).toBeNull();
    expect(parseClockTime("09:60")).toBeNull();
    expect(parseClockTime("nine")).toBeNull();
    expect(parseClockTime("")).toBeNull();
    expect(isValidClockTime("09:00")).toBe(true);
    expect(isValidClockTime("0900")).toBe(false);
  });
});

describe("overnight + span math", () => {
  it("a day shift: 09:00–17:00 with a 30-min break pays 7.5 h", () => {
    expect(shiftIsOvernight("09:00", "17:00")).toBe(false);
    expect(shiftDurationMinutes({ startTime: "09:00", endTime: "17:00", breakMinutes: 30 })).toBe(450);
    expect(shiftExpectedHours({ startTime: "09:00", endTime: "17:00", breakMinutes: 30 })).toBe(7.5);
  });

  it("an overnight shift crosses midnight: 22:00–06:00 with no break pays 8 h", () => {
    expect(shiftIsOvernight("22:00", "06:00")).toBe(true);
    expect(shiftDurationMinutes({ startTime: "22:00", endTime: "06:00", breakMinutes: 0 })).toBe(480);
    expect(shiftExpectedHours({ startTime: "22:00", endTime: "06:00", breakMinutes: 0 })).toBe(8);
  });

  it("a break longer than the span is refused (null), not negative", () => {
    expect(shiftDurationMinutes({ startTime: "09:00", endTime: "10:00", breakMinutes: 90 })).toBeNull();
    expect(shiftExpectedHours({ startTime: "09:00", endTime: "10:00", breakMinutes: 90 })).toBeNull();
  });

  it("unparsable clock strings are null, never NaN", () => {
    expect(shiftDurationMinutes({ startTime: "xx", endTime: "17:00" })).toBeNull();
    expect(shiftIsOvernight("xx", "06:00")).toBe(false);
  });
});

describe("shift validation twin", () => {
  const ok = { name: "Early birds", startTime: "06:00", endTime: "14:00", breakMinutes: 30 };

  it("accepts a sane shift", () => {
    expect(isValidShiftInput(ok)).toBeNull();
  });

  it("refuses a blank name, bad clocks, identical times and an over-long break", () => {
    expect(isValidShiftInput({ ...ok, name: "  " })).toMatch(/name/i);
    expect(isValidShiftInput({ ...ok, startTime: "6am" })).toMatch(/start time/i);
    expect(isValidShiftInput({ ...ok, endTime: "25:00" })).toMatch(/end time/i);
    expect(isValidShiftInput({ ...ok, startTime: "06:00", endTime: "06:00" })).toMatch(/same/i);
    expect(isValidShiftInput({ ...ok, breakMinutes: 300 })).toMatch(/break/i);
  });
});

describe("roster conflict detection (no double-booking)", () => {
  const existing = [
    { employeeId: "u-yuki", rosterDay: "2026-11-16" },
    { employeeId: "u-theo", rosterDay: "2026-11-16" },
    { employeeId: "u-yuki", rosterDay: "2026-11-17" },
  ];

  it("finds the conflict for an already-rostered employee-day, misses everyone else", () => {
    expect(findRosterConflict(existing, "u-yuki", "2026-11-16")).toEqual({ employeeId: "u-yuki", rosterDay: "2026-11-16" });
    expect(findRosterConflict(existing, "u-theo", "2026-11-16")).toEqual({ employeeId: "u-theo", rosterDay: "2026-11-16" });
    expect(findRosterConflict(existing, "u-yuki", "2026-11-18")).toBeNull();
    expect(findRosterConflict(existing, "u-ada", "2026-11-16")).toBeNull();
  });
});

describe("absence candidates (assigned but no attendance = absent)", () => {
  const slots = [
    { id: "a-1", employeeId: "u-yuki", rosterDay: "2026-11-16", status: "SCHEDULED" },
    { id: "a-2", employeeId: "u-theo", rosterDay: "2026-11-16", status: "SCHEDULED" },
    { id: "a-3", employeeId: "u-ada", rosterDay: "2026-11-16", status: "SCHEDULED" },
    { id: "a-4", employeeId: "u-kim", rosterDay: "2026-11-16", status: "COMPLETED" },
    { id: "a-5", employeeId: "u-rex", rosterDay: "2026-11-16", status: "SWAPPED" },
  ];

  it("flags SCHEDULED slots with no mark; COMPLETED/SWAPPED never re-flag", () => {
    const marked = new Set(["u-theo|2026-11-16"]);
    expect(absenceCandidates(slots, marked)).toEqual([
      { id: "a-1", employeeId: "u-yuki", rosterDay: "2026-11-16" },
      { id: "a-3", employeeId: "u-ada", rosterDay: "2026-11-16" },
    ]);
  });

  it("all marked → no candidates", () => {
    const marked = new Set(["u-yuki|2026-11-16", "u-theo|2026-11-16", "u-ada|2026-11-16"]);
    expect(absenceCandidates(slots, marked)).toEqual([]);
  });
});
