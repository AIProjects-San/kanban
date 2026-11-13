import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.10 — offer link lifecycle predicates (lib/offer-lifecycle.ts; defect
// F-R5): the expiry predicate both sign and decline honor, plus the
// letter-date formatting that feeds {{startDate}} (F-R11).
// ---------------------------------------------------------------------------

import { isOfferLinkExpired, formatOfferDate, dateOnlyISO } from "@/lib/hiring/offer-lifecycle";

describe("isOfferLinkExpired", () => {
  const now = new Date("2026-11-15T12:00:00.000Z");

  it("a null/absent expiry is live (open-ended / not sent yet)", () => {
    expect(isOfferLinkExpired(null, now)).toBe(false);
    expect(isOfferLinkExpired(undefined, now)).toBe(false);
  });

  it("a future expiry is live", () => {
    expect(isOfferLinkExpired(new Date("2026-11-16T12:00:00.000Z"), now)).toBe(false);
    // Boundary: exactly now is still live (expiry is exclusive).
    expect(isOfferLinkExpired(now, now)).toBe(false);
  });

  it("a past expiry is expired (any instant before now)", () => {
    expect(isOfferLinkExpired(new Date("2026-11-15T11:59:59.999Z"), now)).toBe(true);
    expect(isOfferLinkExpired(new Date("2020-01-01T00:00:00.000Z"), now)).toBe(true);
  });

  it("accepts ISO strings (serialized rows) and treats invalid dates as live", () => {
    expect(isOfferLinkExpired("2026-11-14T00:00:00.000Z", now)).toBe(true);
    expect(isOfferLinkExpired("2026-11-16T00:00:00.000Z", now)).toBe(false);
    // An unparseable value must never read as expired — the status machine,
    // not a garbage timestamp, decides.
    expect(isOfferLinkExpired("not-a-date", now)).toBe(false);
  });
});

describe("formatOfferDate (the {{startDate}} value, F-R11)", () => {
  it("renders \"15 Jan 2027\" — day, short month, year (en-GB)", () => {
    expect(formatOfferDate(new Date("2027-01-15T00:00:00.000Z"))).toMatch(/15 Jan 2027/);
    expect(formatOfferDate("2027-01-15T00:00:00.000Z")).toMatch(/15 Jan 2027/);
  });

  it("empty/invalid input yields \"\" — never \"Invalid Date\" in a candidate-facing letter", () => {
    expect(formatOfferDate(null)).toBe("");
    expect(formatOfferDate(undefined)).toBe("");
    expect(formatOfferDate("")).toBe("");
    expect(formatOfferDate("not-a-date")).toBe("");
  });
});

describe("dateOnlyISO (the editor's date field value)", () => {
  it("renders YYYY-MM-DD from a Date or ISO string", () => {
    expect(dateOnlyISO(new Date("2027-01-15T23:30:00.000Z"))).toBe("2027-01-15");
    expect(dateOnlyISO("2027-01-15T00:00:00.000Z")).toBe("2027-01-15");
  });

  it("empty/invalid input yields \"\"", () => {
    expect(dateOnlyISO(null)).toBe("");
    expect(dateOnlyISO("nope")).toBe("");
  });
});
