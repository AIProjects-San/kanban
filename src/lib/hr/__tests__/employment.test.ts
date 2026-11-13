import { describe, it, expect } from "vitest";
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_DEFS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_STATUS_TRANSITIONS,
  PROBATION_DEFAULT_MONTHS,
  PROBATION_REVIEW_SATISFIED_STATUSES,
  REVIEW_KINDS,
  canTransition,
  defaultProbationEndsAt,
  isEmploymentStatus,
  formatEmployeeNumber,
  parseEmployeeNumber } from "@/lib/hr/employment";

// ---------------------------------------------------------------------------
// F1.6 — employment lifecycle vocabulary (lib/employment.ts): the pure
// transition graph, the probation-end default math, and the QA-19 ""
// (not-tracked) status — the §9.3 hard gate itself is pinned in
// server-actions/__tests__/employment.test.ts because it needs the review
// table. (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1, decision §9.3.)
// ---------------------------------------------------------------------------

describe("transition graph", () => {
  it("allows the four lifecycle arcs from not-tracked, and nothing else", () => {
    expect(EMPLOYMENT_STATUS_TRANSITIONS[""]).toEqual(["PROBATION", "ACTIVE", "EXITED"]);
    expect(canTransition("", "PROBATION")).toBe(true);
    expect(canTransition("", "ACTIVE")).toBe(true);
    expect(canTransition("", "EXITED")).toBe(true);
    // SUSPENDED is for employees HR has classified — never a first move.
    expect(canTransition("", "SUSPENDED")).toBe(false);
  });

  it("probation can only be confirmed or ended", () => {
    expect(EMPLOYMENT_STATUS_TRANSITIONS.PROBATION).toEqual(["ACTIVE", "EXITED"]);
    expect(canTransition("PROBATION", "ACTIVE")).toBe(true);
    expect(canTransition("PROBATION", "EXITED")).toBe(true);
  });

  it("deliberately omits PROBATION → SUSPENDED (the §9.3 gate bypass)", () => {
    // Suspending a probationer would route around the review gate via
    // PROBATION → SUSPENDED → ACTIVE with no completed review. A
    // probationer who must be removed mid-probation is EXITED instead.
    expect(canTransition("PROBATION", "SUSPENDED")).toBe(false);
  });

  it("active can be suspended or exited; suspension reinstates to active", () => {
    expect(EMPLOYMENT_STATUS_TRANSITIONS.ACTIVE).toEqual(["SUSPENDED", "EXITED"]);
    expect(EMPLOYMENT_STATUS_TRANSITIONS.SUSPENDED).toEqual(["ACTIVE", "EXITED"]);
    expect(canTransition("SUSPENDED", "ACTIVE")).toBe(true);
  });

  it("EXITED is terminal — no resurrection, no un-exiting", () => {
    expect(EMPLOYMENT_STATUS_TRANSITIONS.EXITED).toEqual([]);
    for (const to of EMPLOYMENT_STATUSES) {
      expect(canTransition("EXITED", to)).toBe(false);
    }
  });

  it("a no-op move (same status) is not a transition", () => {
    for (const s of EMPLOYMENT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("every status has a label and a badge (the directory renders both)", () => {
    for (const s of EMPLOYMENT_STATUSES) {
      expect(EMPLOYMENT_STATUS_LABELS[s]).toBeTruthy();
      expect(EMPLOYMENT_STATUS_DEFS.some((d) => d.key === s && d.badge)).toBe(true);
    }
    // QA-19: "" renders as "Not set", never as a fabricated status.
    expect(EMPLOYMENT_STATUS_LABELS[""]).toBe("Not set");
  });
});

describe("isEmploymentStatus", () => {
  it("accepts the closed vocabulary including the empty string", () => {
    for (const s of EMPLOYMENT_STATUSES) expect(isEmploymentStatus(s)).toBe(true);
  });

  it("rejects drift and case games", () => {
    for (const bad of ["active", "Terminated", "ON_HOLD", "null", 0, null, undefined]) {
      expect(isEmploymentStatus(bad)).toBe(false);
    }
  });
});

describe("defaultProbationEndsAt (hireDate feeds probation defaults)", () => {
  it("adds PROBATION_DEFAULT_MONTHS calendar months", () => {
    expect(PROBATION_DEFAULT_MONTHS).toBe(3);
    expect(defaultProbationEndsAt(new Date("2026-08-15T00:00:00.000Z")).toISOString())
      .toBe("2026-11-15T00:00:00.000Z");
    expect(defaultProbationEndsAt(new Date("2026-01-31T00:00:00.000Z")).toISOString())
      .toBe("2026-04-30T00:00:00.000Z");
  });

  it("saturates month-ends instead of spilling into the next month", () => {
    // Aug 31 + 3 months saturates to Nov 30 (JavaScript Date semantics).
    expect(defaultProbationEndsAt(new Date("2026-08-31T00:00:00.000Z")).toISOString())
      .toBe("2026-11-30T00:00:00.000Z");
  });

  it("does not mutate the passed hire date", () => {
    const hire = new Date("2026-08-15T00:00:00.000Z");
    defaultProbationEndsAt(hire);
    expect(hire.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("§9.3 gate inputs", () => {
  it("only REVIEWED/ACKNOWLEDGED probation reviews satisfy the gate", () => {
    expect([...PROBATION_REVIEW_SATISFIED_STATUSES]).toEqual(["REVIEWED", "ACKNOWLEDGED"]);
    // DRAFT/SUBMITTED are outstanding — absent from the satisfied set.
    expect(PROBATION_REVIEW_SATISFIED_STATUSES).not.toContain("DRAFT");
    expect(PROBATION_REVIEW_SATISFIED_STATUSES).not.toContain("SUBMITTED");
  });

  it("PROBATION is a review kind, STANDARD stays the default", () => {
    expect(REVIEW_KINDS).toEqual(["STANDARD", "PROBATION"]);
  });
});


describe("EM-B01 (S13) — the employee-number series", () => {
  it("formats the zero-padded EMP-XXXX series", () => {
    expect(formatEmployeeNumber(1)).toBe("EMP-0001");
    expect(formatEmployeeNumber(42)).toBe("EMP-0042");
    expect(formatEmployeeNumber(9999)).toBe("EMP-9999");
    expect(formatEmployeeNumber(10000)).toBe("EMP-10000"); // widens past 4 digits
    expect(formatEmployeeNumber(0)).toBe("EMP-0001"); // floors at 1
    expect(formatEmployeeNumber(-3)).toBe("EMP-0001");
    expect(formatEmployeeNumber(7.9)).toBe("EMP-0007"); // floors fractions
  });

  it("parses its own output; foreign formats parse to null", () => {
    expect(parseEmployeeNumber("EMP-0042")).toBe(42);
    expect(parseEmployeeNumber("EMP-10000")).toBe(10000);
    expect(parseEmployeeNumber(null)).toBeNull();
    expect(parseEmployeeNumber("")).toBeNull();
    expect(parseEmployeeNumber("EMP-")).toBeNull();
    expect(parseEmployeeNumber("E-0042")).toBeNull();
  });
});
