import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P1 G6 — the employment-document kernel tests: the status graph (spec §2),
// the date rules (spec §4: future at submission; reached at effect), the
// change predicates (spec §4: same department/designation/grade refusals
// are the actions'; these are the weaker anything-changed rules), and the
// location axis joining the P33 property registry.
// ---------------------------------------------------------------------------

import {
  EMPLOYMENT_DOC_STATUSES,
  EMPLOYMENT_DOC_STATUS_LABELS,
  EMPLOYMENT_DOC_TRANSITIONS,
  canTransitionEmploymentDoc,
  isEmploymentDocStatus,
  isFutureDay,
  isEffectiveDayReached,
  utcDayKeyOf,
  dayKeyToDate,
  transferCarriesAnyAxis,
  transferChangesAnyFact,
  promotionChangesAnyFact,
  CANCELABLE_EMPLOYMENT_DOC_STATUSES,
  isEmploymentDocKind,
} from "../employment-documents";
import {
  EMPLOYMENT_PROPERTIES,
  EMPLOYMENT_PROPERTY_LABELS,
  planEmploymentChange,
} from "../employment-change";

describe("G6 kernel — the status graph (spec §2)", () => {
  it("carries the five statuses with labels", () => {
    expect(EMPLOYMENT_DOC_STATUSES).toEqual([
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "EFFECTIVE",
      "CANCELLED",
    ]);
    for (const s of EMPLOYMENT_DOC_STATUSES) {
      expect(EMPLOYMENT_DOC_STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it("allows exactly the spec's arcs", () => {
    expect(EMPLOYMENT_DOC_TRANSITIONS.DRAFT).toContain("PENDING_APPROVAL");
    expect(EMPLOYMENT_DOC_TRANSITIONS.PENDING_APPROVAL).toContain("APPROVED");
    expect(EMPLOYMENT_DOC_TRANSITIONS.APPROVED).toContain("EFFECTIVE");
    // Every pre-EFFECTIVE state may cancel.
    for (const s of ["DRAFT", "PENDING_APPROVAL", "APPROVED"] as const) {
      expect(EMPLOYMENT_DOC_TRANSITIONS[s]).toContain("CANCELLED");
    }
  });

  it("EFFECTIVE and CANCELLED are terminal", () => {
    expect(EMPLOYMENT_DOC_TRANSITIONS.EFFECTIVE).toEqual([]);
    expect(EMPLOYMENT_DOC_TRANSITIONS.CANCELLED).toEqual([]);
    for (const from of EMPLOYMENT_DOC_STATUSES) {
      expect(canTransitionEmploymentDoc("EFFECTIVE", from)).toBe(false);
      expect(canTransitionEmploymentDoc("CANCELLED", from)).toBe(false);
    }
  });

  it("refuses the illegal shortcuts (DRAFT → APPROVED, DRAFT → EFFECTIVE, …)", () => {
    expect(canTransitionEmploymentDoc("DRAFT", "APPROVED")).toBe(false);
    expect(canTransitionEmploymentDoc("DRAFT", "EFFECTIVE")).toBe(false);
    expect(canTransitionEmploymentDoc("PENDING_APPROVAL", "EFFECTIVE")).toBe(false);
    expect(canTransitionEmploymentDoc("PENDING_APPROVAL", "DRAFT")).toBe(false);
    expect(canTransitionEmploymentDoc("APPROVED", "DRAFT")).toBe(false);
    expect(canTransitionEmploymentDoc("APPROVED", "PENDING_APPROVAL")).toBe(false);
  });

  it("guards the status + kind type predicates", () => {
    expect(isEmploymentDocStatus("DRAFT")).toBe(true);
    expect(isEmploymentDocStatus("SUPERSEDED")).toBe(false);
    expect(isEmploymentDocKind("TRANSFER")).toBe(true);
    expect(isEmploymentDocKind("TRANSFER Advice")).toBe(false);
  });

  it("names the cancelable set (pre-EFFECTIVE only)", () => {
    expect(CANCELABLE_EMPLOYMENT_DOC_STATUSES).toEqual([
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
    ]);
  });
});

describe("G6 kernel — the date rules (spec §4)", () => {
  it("future-at-submission is STRICTLY after today", () => {
    expect(isFutureDay("2026-11-14", "2026-11-13")).toBe(true);
    expect(isFutureDay("2026-11-13", "2026-11-13")).toBe(false); // today is not the future
    expect(isFutureDay("2026-11-12", "2026-11-13")).toBe(false);
  });

  it("effective-day-reached is on-or-after", () => {
    expect(isEffectiveDayReached("2026-11-13", "2026-11-13")).toBe(true);
    expect(isEffectiveDayReached("2026-11-12", "2026-11-13")).toBe(true);
    expect(isEffectiveDayReached("2026-11-14", "2026-11-13")).toBe(false);
  });

  it("the day-key helpers round-trip UTC midnight", () => {
    const d = dayKeyToDate("2026-11-13");
    expect(d.toISOString()).toBe("2026-11-13T00:00:00.000Z");
    expect(utcDayKeyOf(d)).toBe("2026-11-13");
  });
});

describe("G6 kernel — the change predicates", () => {
  const facts = {
    department: "ENGINEERING",
    jobTitle: "Senior Frontend Engineer",
    grade: "L4",
    location: "Auckland",
    managerId: "u-ingrid" as string | null,
  };

  it("a transfer must carry at least one axis", () => {
    expect(transferCarriesAnyAxis({})).toBe(false);
    expect(transferCarriesAnyAxis({ toDepartment: "DESIGN" })).toBe(true);
    expect(transferCarriesAnyAxis({ toManagerId: null })).toBe(true);
  });

  it("detects a real change per axis (and nothing when all axes match)", () => {
    expect(
      transferChangesAnyFact(facts, { toDepartment: "DESIGN" }),
    ).toBe(true);
    expect(transferChangesAnyFact(facts, { toJobTitle: "Staff Engineer" })).toBe(true);
    expect(transferChangesAnyFact(facts, { toLocation: "Wellington" })).toBe(true);
    expect(transferChangesAnyFact(facts, { toManagerId: "u-ada" })).toBe(true);
    // Clearing a set manager is a change; clearing an absent one is not.
    expect(transferChangesAnyFact(facts, { toManagerId: null })).toBe(true);
    expect(
      transferChangesAnyFact({ ...facts, managerId: null }, { toManagerId: null }),
    ).toBe(false);
    // Same values on the un-named axes — nothing changes.
    expect(
      transferChangesAnyFact(facts, {
        toDepartment: "ENGINEERING", // refused by the action's named rule
        toJobTitle: "Senior Frontend Engineer",
        toLocation: "Auckland",
        toManagerId: "u-ingrid",
      }),
    ).toBe(false);
  });

  it("the promotion predicate rides the designation and grade axes", () => {
    expect(promotionChangesAnyFact(facts, { toJobTitle: "Staff Engineer" })).toBe(true);
    expect(
      promotionChangesAnyFact(facts, { toJobTitle: "Staff Engineer", toGrade: "L5" }),
    ).toBe(true);
    expect(promotionChangesAnyFact(facts, { toJobTitle: "Senior Frontend Engineer" })).toBe(
      false, // same designation — refused by the action's named rule
    );
  });
});

describe("G6 — location joins the P33 property registry", () => {
  it("registers location beside the original five", () => {
    expect(EMPLOYMENT_PROPERTIES).toContain("location");
    expect(EMPLOYMENT_PROPERTY_LABELS.location).toBe("Location");
  });

  it("plans a location diff row (one row per CHANGED property — unchanged ones record nothing)", () => {
    const rows = planEmploymentChange({
      current: { location: "Auckland", department: "Engineering" },
      requested: { location: "Wellington", department: "Engineering" },
    });
    expect(rows).toEqual([
      { property: "location", currentValue: "Auckland", newValue: "Wellington" },
    ]);
  });

  it("leaves the P33 writer's diffs untouched when location is absent", () => {
    const rows = planEmploymentChange({
      current: { jobTitle: "Engineer", department: "Engineering" },
      requested: { jobTitle: "Senior Engineer" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].property).toBe("jobTitle");
  });
});
