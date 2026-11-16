import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// R-P0-4 — ICS export hardening (REVIEW_TRIAGE §4.3, pre-check C decision:
// strip PII at the writer + renderer defense; TZID/VTIMEZONE).
//
// The matrix: 3 timezones (Pacific/Auckland — the product's jurisdiction
// and the default, Australia/Sydney, UTC) × 2 event shapes (timed, all-day
// date-only) — each asserts the RFC 5545 property that makes the export
// round-trip: a wall-clock label stored under the house convention
// (UTC-midnight day + "HH:MM") renders as a TZID-qualified LOCAL time, so
// "9:00 AM Pacific/Auckland" stays 9:00 AM in any importing client.
// Plus the PII defense cases (legacy interview titles, embedded emails)
// and the fail-loud unsupported-timezone refusal.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["calendarEvent"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "update", "delete", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const getSessionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => {
  class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  }
  return {
    getSession: () => getSessionMock(),
    getSessionOrThrow: async () => {
      const a = await getSessionMock();
      if (!a) throw new AuthorizationError("You must be signed in.");
      return a;
    },
    AuthorizationError,
  };
});

import { exportCalendarIcs } from "../ics-export";

const USER = { userId: "u-1", role: "MEMBER" as const, name: "Ana", email: "ana@x.co" };

/** A stored event row on the house basis (UTC-midnight day + HH:MM label). */
function evt(overrides: Partial<Parameters<typeof Object>[0]> & Record<string, unknown>): Record<string, unknown> {
  return {
    id: "evt-x",
    title: "Standup",
    description: "",
    location: "",
    type: "MEETING",
    date: new Date(Date.UTC(2026, 10, 16)), // 2026-11-16 (UTC midnight)
    time: "09:00",
    durationMin: 60,
    createdAt: new Date(Date.UTC(2026, 10, 1)),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(USER);
});

describe("R-P0-4 — TZID/VTIMEZONE matrix (3 timezones × 2 event shapes)", () => {
  it("Pacific/Auckland × timed: 9:00 AM stays 9:00 AM — TZID-qualified local time + VTIMEZONE", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-akl" })]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    const ics = res.data.ics;
    // The round-trip property: the wall-clock label the picker chose is
    // emitted verbatim as the LOCAL time under the TZID — an importing
    // client (Auckland, Sydney, London) resolves the same instant and
    // renders 9:00 AM Auckland.
    expect(ics).toContain("DTSTART;TZID=Pacific/Auckland:20261116T090000");
    expect(ics).toContain("DTEND;TZID=Pacific/Auckland:20261116T100000");
    // The matching VTIMEZONE definition rides the document (NZ rules:
    // NZST +12, NZDT +13, April/September transitions).
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Pacific/Auckland");
    expect(ics).toContain("TZNAME:NZST");
    expect(ics).toContain("TZNAME:NZDT");
    expect(ics).toContain("TZOFFSETTO:+1300");
    expect(ics).toContain("RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU");
    expect(ics).toContain("RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU");
    // DTSTAMP stays UTC (RFC 5545).
    expect(ics).toContain("DTSTAMP:20261101T000000Z");
    expect(res.data.redactedCount).toBe(0);
  });

  it("Pacific/Auckland × all-day: date-only VEVENT, no invented time", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-akl-ad", time: "" })]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("DTSTART;VALUE=DATE:20261116");
    // DTEND omitted = spans the one calendar day (RFC 5545 §3.6.1); no
    // timed start was invented (the VTIMEZONE's internal DTSTARTs are the
    // 1970 rule anchors, not event starts).
    expect(res.data.ics).not.toContain("DTSTART;TZID=");
    expect(res.data.ics).not.toContain("DTEND");
  });

  it("Australia/Sydney × timed: the timezone option carries the same label verbatim", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-syd" })]);
    const res = await exportCalendarIcs({ timezone: "Australia/Sydney" });
    if (!res.ok) throw new Error("expected ok");
    const ics = res.data.ics;
    expect(ics).toContain("DTSTART;TZID=Australia/Sydney:20261116T090000");
    expect(ics).toContain("DTEND;TZID=Australia/Sydney:20261116T100000");
    // The Sydney VTIMEZONE (AEST/AEDT, October start) — and ONLY that one.
    expect(ics).toContain("TZID:Australia/Sydney");
    expect(ics).toContain("TZNAME:AEST");
    expect(ics).toContain("TZNAME:AEDT");
    expect(ics).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU");
    expect(ics).not.toContain("TZID:Pacific/Auckland");
  });

  it("Australia/Sydney × all-day: date-only under the option timezone", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-syd-ad", time: "not-a-time" })]);
    const res = await exportCalendarIcs({ timezone: "Australia/Sydney" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("DTSTART;VALUE=DATE:20261116");
    expect(res.data.ics).not.toContain("DTEND");
  });

  it("UTC × timed: Z-form rendering, no TZID, no VTIMEZONE", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-utc" })]);
    const res = await exportCalendarIcs({ timezone: "UTC" });
    if (!res.ok) throw new Error("expected ok");
    const ics = res.data.ics;
    expect(ics).toContain("DTSTART:20261116T090000Z");
    expect(ics).toContain("DTEND:20261116T100000Z");
    expect(ics).not.toContain("TZID=");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("UTC × all-day: date-only under the UTC option", async () => {
    db.calendarEvent.findMany.mockResolvedValue([evt({ id: "evt-utc-ad", time: "" })]);
    const res = await exportCalendarIcs({ timezone: "Etc/UTC" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("DTSTART;VALUE=DATE:20261116");
    expect(res.data.ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("wall-clock duration math rolls over midnight (23:30 + 90min = next day 01:00)", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      evt({ id: "evt-late", time: "23:30", durationMin: 90 }),
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("DTSTART;TZID=Pacific/Auckland:20261116T233000");
    expect(res.data.ics).toContain("DTEND;TZID=Pacific/Auckland:20261117T010000");
  });

  it("an unsupported timezone fails loudly with a named error — never an unresolvable TZID", async () => {
    db.calendarEvent.findMany.mockResolvedValue([]);
    const res = await exportCalendarIcs({ timezone: "Mars/Olympus_Mons" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Mars/Olympus_Mons");
      expect(res.error).toContain("Pacific/Auckland");
    }
    // No document was rendered on the refusal path.
    expect(db.calendarEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("R-P0-4 — PII renderer defense (legacy rows; the writer no longer emits PII)", () => {
  it("a legacy interview title (candidate name) is redacted; the name appears nowhere in the document", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      evt({
        id: "evt-legacy",
        title: "Interview: Nadia Petrova — Interview 1 — Technical",
        description: "SWE · nadia@example.com",
        location: "ENGINEERING",
      }),
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    const ics = res.data.ics;
    expect(ics).toContain("SUMMARY:Interview — details redacted");
    // The candidate name AND email are absent from the ENTIRE document —
    // the property a non-HR viewer's export must hold.
    expect(ics).not.toContain("Nadia");
    expect(ics).not.toContain("nadia@example.com");
    // The email-carrying description was dropped whole; the clean location
    // passed through.
    expect(ics).not.toContain("DESCRIPTION:");
    expect(ics).toContain("LOCATION:ENGINEERING");
    expect(res.data.redactedCount).toBe(1);
  });

  it("an email embedded in a title redacts to the generic form; clean fields pass through", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      evt({
        id: "evt-mail",
        title: "Catch up with someone@example.com",
        description: "Bring the roadmap",
      }),
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    const ics = res.data.ics;
    expect(ics).toContain("SUMMARY:Event — details redacted");
    expect(ics).not.toContain("someone@example.com");
    expect(ics).toContain("DESCRIPTION:Bring the roadmap");
    expect(res.data.redactedCount).toBe(1);
  });

  it("clean events pass through untouched — redactedCount is the honest zero", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      evt({ id: "evt-clean", title: "Sprint planning", description: "Weekly sync", location: "Room 4" }),
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("SUMMARY:Sprint planning");
    expect(res.data.ics).toContain("DESCRIPTION:Weekly sync");
    expect(res.data.redactedCount).toBe(0);
  });
});
