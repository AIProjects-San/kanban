// ---------------------------------------------------------------------------
// F-R18 (S18) — interview calendar events on ONE day basis
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
//
// The finding: scheduleInterview used to store the interview's CalendarEvent
// as `date = the full instant` + `time = the SERVER-LOCAL HH:MM` of that
// instant. Two bases, three readers, three answers — the calendar groups by
// the browser-local day of the instant, the ICS export recombines the
// UTC-day of `date` with `time`-as-UTC, and around midnight (or on any
// server whose TZ ≠ the users') the event could land on a different DAY
// than the one the HR user picked, with a time label nobody chose.
//
// The fix keeps the two facts the client actually knows, each on the basis
// where it is true:
//   • the INSTANT (`scheduledAt`, ISO with offset) stays the scheduling
//     truth — the clash guard (±59 min on instants), the stage row and the
//     interviewer reminder never cared about wall-clocks and still don't;
//   • the WALL-CLOCK the user picked (the raw `datetime-local` string,
//     "YYYY-MM-DDTHH:MM") becomes the display truth — the calendar event's
//     day + label, derived by THIS kernel onto the generic-events house
//     convention (events.ts): `date` = UTC midnight of the picked calendar
//     day, `time` = the picked "HH:MM".
//
// Interview events therefore sit on exactly the same (date, time) basis as
// every other calendar event the app writes, so every reader — the calendar
// grid, the upcoming feed, the ICS export's documented parse-as-UTC —
// renders one basis for all events, and the day the user picked is the day
// on screen regardless of the server's timezone.
//
// Pure by the house rule: no I/O, no clock, no locale — a pure function of
// the string the user picked. Validation is shape + real-calendar-date
// (QA-10b discipline: "2026-02-30" refuses here, not at the Prisma write)
// and throws (the zod schema mirrors the same rules at the action boundary;
// arriving garbage is a client bug, not a fail-soft read).
// ---------------------------------------------------------------------------

/** The raw `datetime-local` value the HR user picked. */
export type InterviewWallClock = string;

/** What the CalendarEvent row stores — the generic-events convention. */
export interface PlannedInterviewEvent {
  /** UTC midnight of the picked calendar day (how events.ts stores dates). */
  date: Date;
  /** The picked wall-clock, "HH:MM" 24-hour. */
  time: string;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** F-R18 (S18) — derive the calendar-event pair from the picked
 * wall-clock. Throws on a malformed or impossible value (shape, calendar
 * date, or 00–23 / 00–59 ranges — the message names the expected form). */
export function planInterviewEvent(wallClock: InterviewWallClock): PlannedInterviewEvent {
  const m = WALL_CLOCK_RE.exec(wallClock);
  if (!m) {
    throw new Error("Wall-clock must be 'YYYY-MM-DDTHH:MM' (a datetime-local value).");
  }
  const [, ys, ms, ds, hs, mins] = m;
  const [y, mo, d] = [Number(ys), Number(ms), Number(ds)];
  // QA-10b — construct-then-verify: only a real calendar date round-trips
  // (2026-02-30 → March 2nd → mismatch → refuse).
  const midnight = new Date(Date.UTC(y, mo - 1, d));
  if (
    midnight.getUTCFullYear() !== y ||
    midnight.getUTCMonth() !== mo - 1 ||
    midnight.getUTCDate() !== d
  ) {
    throw new Error(`"${ys}-${ms}-${ds}" is not a real calendar date.`);
  }
  const [h, mi] = [Number(hs), Number(mins)];
  if (h > 23 || mi > 59) {
    throw new Error(`"${hs}:${mins}" is not a valid 24-hour time.`);
  }
  return { date: midnight, time: `${hs}:${mins}` };
}
