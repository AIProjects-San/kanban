"use server";

// ---------------------------------------------------------------------------
// L-P2-38 — ICS calendar export.
//
// The audit (§9.6 L-P2-38) asked for ICS export at minimum (recurrence and
// drag-to-move are polish). `exportCalendarIcs` renders all non-deleted
// calendar events as RFC 5545 VEVENTs so users can round-trip Fernly's
// calendar with Google/Apple/Outlook.
//
// Week/agenda views + RRULE recurrence + ICS import are follow-up.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { getSessionOrThrow } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
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

export interface IcsExport {
  /** The full iCalendar document text. */
  ics: string;
  /** Number of events included. */
  eventCount: number;
  /** PR-05 — true when the export hit its row cap and is a partial export. */
  truncated: boolean;
}

/** PR-05 (production-readiness audit) — hard cap on the export size. The
 * query previously ran with no `take`, so a workspace with years of events
 * (or a bot spamming events) would render an unbounded ICS document in
 * memory. 1000 events ≈ a multi-year workspace; beyond that the client
 * shows a "partial export" notice instead of pretending completeness. */
const ICS_EXPORT_MAX_EVENTS = 1000;

/**
 * Export every calendar event as an ICS document. Any signed-in user can
 * export (the calendar is workspace-wide by design; per-user scoping is the
 * L-P2-36 tenancy follow-up).
 */
export async function exportCalendarIcs(): Promise<ActionResult<IcsExport>> {
  return toResult(async () => {
    await getSessionOrThrow();

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

    for (const e of events) {
      // The model stores a date + a "HH:MM" time string. Parse both as UTC
      // for determinism (the UI renders in the viewer's timezone). F-R18
      // (S18): every writer — generic events AND interview events — now
      // stores the same basis (UTC-midnight day + wall-clock label), so
      // this recombination means one thing for the whole calendar.
      const [y, m, d] = [
        e.date.getUTCFullYear(),
        e.date.getUTCMonth(),
        e.date.getUTCDate(),
      ];
      const [hh, mm] = e.time.split(":").map((n) => parseInt(n, 10));
      const start = new Date(Date.UTC(y, m, d, isNaN(hh) ? 9 : hh, isNaN(mm) ? 0 : mm));
      const end = new Date(start.getTime() + e.durationMin * 60 * 1000);

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${e.id}@${APP.domain}`);
      lines.push(`DTSTAMP:${icsUtc(e.createdAt)}`);
      lines.push(`DTSTART:${icsUtc(start)}`);
      lines.push(`DTEND:${icsUtc(end)}`);
      lines.push(`SUMMARY:${icsEscape(e.title)}`);
      if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
      if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
      lines.push(`CATEGORIES:${icsEscape(e.type)}`);
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    return {
      ics: lines.map(csFoldLine).join("\r\n") + "\r\n",
      eventCount: events.length,
      truncated,
    };
  });
}
