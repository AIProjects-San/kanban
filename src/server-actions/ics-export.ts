"use server";

// ---------------------------------------------------------------------------
// L-P2-38 — ICS calendar export. R-P0-4 (REVIEW_TRIAGE §4.3, corrected R-P0
// batch) hardened it along three axes before it is ever wired into the UI
// (R-P1-2 owns the wiring; today it has zero UI callers):
//
//   1. TZID/VTIMEZONE — every timed DTSTART/DTEND is emitted as a
//      timezone-qualified local time (`DTSTART;TZID=Pacific/Auckland:
//      20261116T090000`) with the matching VTIMEZONE definition in the
//      document, so a 9:00 AM Auckland event round-trips as 9:00 AM in
//      ANY importing client regardless of its own timezone. The stored
//      basis (UTC-midnight day + "HH:MM" wall-clock label, the F-R18/S18
//      house convention) means the label IS the intended local time — the
//      old parse-as-UTC rendering silently reinterpreted it as UTC.
//   2. PII renderer defense (pre-check C decision: strip at the writer —
//      hiring-interviews.ts no longer writes candidate names/emails into
//      event fields; THIS is the second layer for legacy rows). A title
//      matching the legacy interview format (`Interview: <name> — <stage>`)
//      or any field carrying an email address is redacted on export;
//      redactions are counted in the result, never silent. Legacy stored
//      rows are cleaned by R-P0-8's one-time migration.
//   3. All-day honesty — an event with an empty/unparseable time renders
//      as a date-only VEVENT (`DTSTART;VALUE=DATE`) instead of silently
//      inventing a 09:00 start. (Writers always store a real "HH:MM", so
//      this only fires on legacy/direct-DB rows; it is the forward
//      convention for all-day support.)
//
// Supported timezones: a registry of VTIMEZONE definitions (the product's
// jurisdiction Pacific/Auckland, Australia/Sydney, and UTC in Z-form). An
// unknown timezone FAILS LOUDLY with a named error — emitting a TZID
// without its VTIMEZONE would be the silent-wrong-values failure mode
// this batch exists to kill.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { APP } from "@/config/app";

/**
 * Format a Date as an RFC 5545 UTC timestamp: YYYYMMDDTHHMMSSZ.
 */
function icsUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Escape text per RFC 5545 (backslash, semicolons, commas, newlines). */
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold long lines at 75 octets with a leading space (RFC 5545 §3.1). */
function csFoldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return parts.join("\r\n");
}

// ---------------------------------------------------------------------------
// R-P0-4 — timezone registry + local-time rendering.
// ---------------------------------------------------------------------------

/** The product's jurisdiction timezone — the export default. The NZ
 * statutory engine, IRD filings and the demo seed are all Pacific/Auckland;
 * a per-workspace timezone setting is future config work, not invented
 * here. (Not exported: "use server" files may only export async functions
 * — the default is exercised through the no-argument call.) */
const ICS_DEFAULT_TIMEZONE = "Pacific/Auckland";

/** UTC spellings that render in Z-form (no TZID, no VTIMEZONE needed). */
const UTC_TZIDS = new Set(["UTC", "Etc/UTC", "GMT"]);

/** One STANDARD/DAYLIGHT pair of a VTIMEZONE component (RFC 5545 §3.6.5).
 * The RRULEs are the post-2007 rules; DTSTARTs are the canonical
 * 1970-anchored instances tzdata-derived producers emit. */
interface VtimezoneDef {
  /** The component's lines (folded individually — a pre-joined block would
   * be re-folded mid-content by the document-level csFoldLine pass). */
  lines: string[];
}

function vtimezone(
  tzid: string,
  stdName: string, stdFrom: string, stdTo: string, stdRule: string,
  dltName: string, dltFrom: string, dltTo: string, dltRule: string,
): VtimezoneDef {
  return {
    lines: [
      "BEGIN:VTIMEZONE",
      `TZID:${tzid}`,
      "BEGIN:STANDARD",
      "DTSTART:19700405T020000",
      stdRule,
      `TZOFFSETFROM:${stdFrom}`,
      `TZOFFSETTO:${stdTo}`,
      `TZNAME:${stdName}`,
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700927T020000",
      dltRule,
      `TZOFFSETFROM:${dltFrom}`,
      `TZOFFSETTO:${dltTo}`,
      `TZNAME:${dltName}`,
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ],
  };
}

/** The supported TZIDs and their VTIMEZONE definitions. Adding a timezone
 * here is the ONLY way exportCalendarIcs accepts it — an entry without a
 * real definition would render an unresolvable TZID. */
const VTIMEZONE_REGISTRY: Record<string, VtimezoneDef> = {
  // NZ: DST ends first Sunday in April (03:00 NZDT → 02:00 NZST), starts
  // last Sunday in September (02:00 NZST → 03:00 NZDT).
  "Pacific/Auckland": vtimezone(
    "Pacific/Auckland",
    "NZST", "+1300", "+1200", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
    "NZDT", "+1200", "+1300", "RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU",
  ),
  // AU NSW: DST ends first Sunday in April, starts first Sunday in October.
  "Australia/Sydney": vtimezone(
    "Australia/Sydney",
    "AEST", "+1100", "+1000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
    "AEDT", "+1000", "+1100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
  ),
};

/** A stored "HH:MM" label, or null when absent/unparseable (→ all-day). */
function parseTimeLabel(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** YYYYMMDDTHHMMSS from a UTC-midnight day + wall-clock pair — the local
 * time under the event's TZID (the label the picker chose). */
function icsLocal(day: Date, hh: number, mm: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}` +
    `T${pad(hh)}${pad(mm)}00`
  );
}

/** YYYYMMDD from a UTC-midnight day (date-only, VALUE=DATE form). */
function icsDateOnly(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}`;
}

/** Wall-clock end: start label + duration with day rollover (23:30 + 90min
 * = next day 01:00 — instant math across a TZID boundary would be wrong).
 * The day math rides UTC milliseconds on a UTC-midnight date, so it is
 * pure arithmetic on the stored basis. */
function wallClockEnd(
  day: Date, hh: number, mm: number, durationMin: number,
): { day: Date; hh: number; mm: number } {
  const total = hh * 60 + mm + Math.max(0, Math.trunc(durationMin));
  const dayOffset = Math.floor(total / 1440);
  const rem = total % 1440;
  return {
    day: new Date(day.getTime() + dayOffset * 86_400_000),
    hh: Math.floor(rem / 60),
    mm: rem % 60,
  };
}

// ---------------------------------------------------------------------------
// R-P0-4 — PII renderer defense (layer 2; the writer is layer 1, R-P0-8's
// migration is layer 3 for stored rows).
// ---------------------------------------------------------------------------

/** Email-shaped substring — the PII the legacy interview writer embedded
 * in descriptions (`${position} · ${email}`). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The legacy interview title the writer produced before R-P0-4:
 * `Interview: ${fullName} — ${stage.label}`. The format is deterministic,
 * so the pattern redacts every legacy row without needing a name list. */
const LEGACY_INTERVIEW_TITLE_RE = /^Interview:\s.+\s—\s.+$/;

const REDACTED_INTERVIEW_TITLE = "Interview — details redacted";
const REDACTED_GENERIC_TITLE = "Event — details redacted";

/** Redact a title matching a PII pattern; pass clean titles through. */
function redactTitle(title: string): string {
  if (LEGACY_INTERVIEW_TITLE_RE.test(title)) return REDACTED_INTERVIEW_TITLE;
  if (EMAIL_RE.test(title)) return REDACTED_GENERIC_TITLE;
  return title;
}

/** Redact a free-text field (description/location) carrying an email —
 * partial scrubbing of free text is unreliable, so the field is dropped
 * whole rather than half-cleaned. */
function redactText(text: string): string {
  return EMAIL_RE.test(text) ? "" : text;
}

export interface IcsExport {
  /** The full iCalendar document text. */
  ics: string;
  /** Number of events included. */
  eventCount: number;
  /** PR-05 — true when the export hit its row cap and is a partial export. */
  truncated: boolean;
  /** R-P0-4 — number of events whose fields were PII-redacted on export
   * (renderer defense). Zero is the steady state once R-P0-8 has cleaned
   * legacy rows; a sustained non-zero count means stored data needs a
   * migration re-run, not a shrug. */
  redactedCount: number;
}

/** PR-05 (production-readiness audit) — hard cap on the export size. The
 * query previously ran with no `take`, so a workspace with years of events
 * (or a bot spamming events) would render an unbounded ICS document in
 * memory. 1000 events ≈ a multi-year workspace; beyond that the client
 * shows a "partial export" notice instead of pretending completeness. */
const ICS_EXPORT_MAX_EVENTS = 1000;

/** Options for the export. `timezone` is the IANA TZID the stored
 * wall-clock labels are rendered under — the product's jurisdiction
 * (Pacific/Auckland) by default. It must be in the supported registry
 * (or a UTC spelling); anything else fails loudly with a named error. */
export interface IcsExportOptions {
  timezone?: string;
}

/**
 * Export every calendar event as an ICS document. Any signed-in user can
 * export (the calendar is workspace-wide by design; per-user scoping is the
 * L-P2-36 tenancy follow-up). PII never survives to the rendered document:
 * the writer stopped emitting it (R-P0-4), this renderer redacts legacy
 * patterns (defense in depth), and R-P0-8 migrates the stored rows.
 */
export async function exportCalendarIcs(
  opts?: IcsExportOptions,
): Promise<ActionResult<IcsExport>> {
  return toResult(async () => {
    await getSessionOrThrow();

    const tzid = opts?.timezone ?? ICS_DEFAULT_TIMEZONE;
    const isUtc = UTC_TZIDS.has(tzid);
    if (!isUtc && !(tzid in VTIMEZONE_REGISTRY)) {
      throw new AuthorizationError(
        `Calendar export timezone "${tzid}" is not supported — use one of: ${[
          ...Object.keys(VTIMEZONE_REGISTRY), ...UTC_TZIDS,
        ].join(", ")}. A TZID without its VTIMEZONE definition would export unresolvable times.`,
      );
    }

    const events = await db.calendarEvent.findMany({
      orderBy: { date: "asc" },
      take: ICS_EXPORT_MAX_EVENTS,
    });
    const truncated = events.length >= ICS_EXPORT_MAX_EVENTS;

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//${APP.name}//Calendar//EN`,
      "CALSCALE:GREGORIAN",
    ];

    // The VTIMEZONE for the (single) export timezone, before the events —
    // line by line, so the document-level fold never re-folds it.
    if (!isUtc) lines.push(...VTIMEZONE_REGISTRY[tzid].lines);

    let redactedCount = 0;

    for (const e of events) {
      // The model stores a date + a "HH:MM" time string. F-R18 (S18): every
      // writer — generic events AND interview events — stores the same basis
      // (UTC-midnight day + wall-clock label), so the label is the intended
      // LOCAL time under the export timezone. R-P0-4: an absent/unparseable
      // label renders as a date-only (all-day) VEVENT — never a silently
      // invented 09:00.
      const label = parseTimeLabel(e.time);
      const timed = label !== null;

      const title = redactTitle(e.title);
      const description = redactText(e.description);
      const location = redactText(e.location);
      if (title !== e.title || description !== e.description || location !== e.location) {
        redactedCount += 1;
      }

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${e.id}@${APP.domain}`);
      lines.push(`DTSTAMP:${icsUtc(e.createdAt)}`);
      if (timed) {
        const startLocal = icsLocal(e.date, label.hh, label.mm);
        if (isUtc) {
          // Z-form: the wall-clock label rendered as UTC.
          lines.push(`DTSTART:${startLocal}Z`);
        } else {
          lines.push(`DTSTART;TZID=${tzid}:${startLocal}`);
        }
        const end = wallClockEnd(e.date, label.hh, label.mm, e.durationMin);
        const endLocal = icsLocal(end.day, end.hh, end.mm);
        if (isUtc) {
          lines.push(`DTEND:${endLocal}Z`);
        } else {
          lines.push(`DTEND;TZID=${tzid}:${endLocal}`);
        }
      } else {
        // Date-only: DTEND omitted = the event spans this one calendar day
        // (RFC 5545 §3.6.1).
        lines.push(`DTSTART;VALUE=DATE:${icsDateOnly(e.date)}`);
      }
      lines.push(`SUMMARY:${icsEscape(title)}`);
      if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
      if (location) lines.push(`LOCATION:${icsEscape(location)}`);
      lines.push(`CATEGORIES:${icsEscape(e.type)}`);
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    return {
      ics: lines.map(csFoldLine).join("\r\n") + "\r\n",
      eventCount: events.length,
      truncated,
      redactedCount,
    };
  });
}
