// P27 (LV-08) — leave period master, pure core
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P27; benchmark:
// frappe/hrms `Leave Period` — named allocation windows).
//
// Pure and dependency-free (only date arithmetic) so BOTH sides import it:
//   • server actions — the request/approve/cancel bucket resolution, the
//     ESS card's display year, and the period CRUD validation
//     (src/server-actions/hr-leave.ts, leave-periods.ts);
//   • the cron job — runLeaveAllocationJob advances the ACTIVE window and
//     rolls the predecessor bucket at the window boundary
//     (src/lib/leave-allocation-core.ts);
//   • unit tests — the full resolution/validation matrix lives here.
//
// THE BUCKET RULE (the one design decision everything else follows from):
// the ledger and its LeaveBalance cache key on an integer `year`. A named
// period maps onto that key as THE CALENDAR YEAR OF ITS START DATE. One
// allocation window per start calendar year (validated) keeps the bucket
// unique; windows are annual (1..370 days) so every strategy grants at most
// one deposit per window; the chain of periods is contiguous (validated)
// so the rollover always knows its predecessor.
//
// THE DEFAULT IS NO ROWS: with an empty period table every date falls to
// the implicit calendar-year window and every code path is byte-identical
// to the pre-P27 behavior (pinned by the existing suites — the window
// parameter is optional everywhere and defaults to the calendar year).
//
// Windows while periods exist:
//   • a date INSIDE a period → that period's window (grants, consumption,
//     caps — everything);
//   • a date in the DEAD ZONE (after the last period ended, before the next
//     one starts — the workspace hasn't defined it yet) → the latest period
//     that ENDED before the date: requests spend against the closed
//     window's bucket (FIFO-honest: dead-zone spend reduces the leftover
//     before any future rollover carries it), and the consumption cap
//     refuses positive balances (the window's end is in the past);
//   • a date BEFORE the first period starts (migration gap — the workspace
//     ran calendar years, then defines its first custom window) → the
//     implicit calendar window of the date's year: consumption keeps
//     working against the calendar buckets exactly as it always did, while
//     the engine grants NOTHING (implicit grants only fire when the period
//     table is empty — a half-migrated workspace must not double-grant).
//   The first period's ROLLOVER source is startYear − 1 (the last calendar
//   bucket with history); a later period's source is its chain predecessor.

import { daysBetween, monthsBetween } from "@/lib/leave-policy";

/** A LeavePeriod row as plain data (the loader maps the DB row; tests build
 * these directly). Dates are "YYYY-MM-DD" day keys (UTC-midnight
 * date-only, the LeaveRequest convention). */
export interface LeavePeriodInput {
  id: string;
  name: string;
  /** Inclusive first day of the window. */
  startDate: string;
  /** Inclusive last day of the window (≥ startDate). */
  endDate: string;
}

/** One resolved allocation window — explicit (a LeavePeriod row) or
 * implicit (the fallback calendar year). */
export interface LeaveWindow {
  /** The ledger bucket this window writes into: the period's start year,
   * or the calendar year itself when implicit. */
  bucketYear: number;
  /** Inclusive first day. */
  start: string;
  /** Inclusive last day. */
  end: string;
  /** The period's name (null when implicit). */
  name: string | null;
  /** The period row's id (null when implicit). */
  periodId: string | null;
}

/** The implicit calendar-year window of a year (the pre-P27 behavior). */
export function implicitCalendarWindow(year: number): LeaveWindow {
  return {
    bucketYear: year,
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    name: null,
    periodId: null,
  };
}

function periodWindow(p: LeavePeriodInput): LeaveWindow {
  return {
    bucketYear: Number(p.startDate.slice(0, 4)),
    start: p.startDate,
    end: p.endDate,
    name: p.name,
    periodId: p.id,
  };
}

/**
 * The window a DATE belongs to, for bucketing and capping:
 *   1. the explicit period containing the date;
 *   2. else, when periods exist, the LATEST period that ended before the
 *      date (the dead zone spends against the closed window);
 *   3. else, when NO periods exist, the implicit calendar year of the
 *      date's year (byte-identical pre-P27 behavior).
 * Pre-first-period dates fall to case 2's sibling: a date before the first
 * period's start has no containing period and no ended-before period, so
 * it falls to the implicit calendar window — consumption keeps working,
 * and the engine's grant phase (resolveActiveWindow) is the only place
 * that refuses to grant into it.
 */
export function windowForDate(periods: ReadonlyArray<LeavePeriodInput>, date: string): LeaveWindow {
  const explicit = periods.map(periodWindow);
  if (explicit.length === 0) {
    return implicitCalendarWindow(Number(date.slice(0, 4)));
  }
  const containing = explicit.find((w) => w.start <= date && date <= w.end);
  if (containing) return containing;
  const endedBefore = explicit
    .filter((w) => w.end < date)
    .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))[0];
  return endedBefore ?? implicitCalendarWindow(Number(date.slice(0, 4)));
}

/**
 * The ACTIVE window the allocation job advances at `asOf`: the period
 * containing asOf, else (dead zone) the latest period that ended before
 * asOf — advancing a closed window is an idempotent no-op (every grant's
 * due date has passed) but the lapse/rollover phases still see the truth.
 * With no periods: the implicit calendar year of asOf (byte-identical).
 */
export function resolveActiveWindow(
  periods: ReadonlyArray<LeavePeriodInput>,
  asOf: string,
): LeaveWindow {
  return windowForDate(periods, asOf);
}

/**
 * The window a LEDGER BUCKET maps to (for the lazy materializer, which is
 * called with a year): the explicit period whose start year is the bucket,
 * else the implicit calendar year. The one-period-per-start-year
 * validation keeps this unambiguous.
 */
export function windowForBucket(
  periods: ReadonlyArray<LeavePeriodInput>,
  year: number,
): LeaveWindow {
  const match = periods.find((p) => Number(p.startDate.slice(0, 4)) === year);
  return match ? periodWindow(match) : implicitCalendarWindow(year);
}

/**
 * The rollover SOURCE bucket for a window: its chain predecessor's bucket
 * (the period ending exactly the day before it starts), or — for the first
 * period — startYear − 1 (the last calendar bucket that carries history;
 * the start year's own calendar window never ran because implicit grants
 * stop the moment the period table is non-empty). Null when the window is
 * implicit (the caller uses the classic year − 1 rule).
 */
export function carrySourceBucket(
  periods: ReadonlyArray<LeavePeriodInput>,
  window: LeaveWindow,
): number | null {
  if (window.periodId === null) return null;
  const dayBefore = addDaysStr(window.start, -1);
  const predecessor = periods.find((p) => p.endDate === dayBefore);
  if (predecessor) return Number(predecessor.startDate.slice(0, 4));
  return window.bucketYear - 1;
}

/** addDays on a "YYYY-MM-DD" key, UTC-midnight arithmetic. */
function addDaysStr(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface PeriodValidation {
  ok: boolean;
  /** The human-readable refusal (empty when ok). */
  reason: string;
}

/**
 * Validate a candidate period against the existing rows. Pure; the action
 * layer adds the DB-level guards (name uniqueness, the forward-looking
 * engine-history check) on top. Rules:
 *   • name trimmed, non-empty, ≤ 80 chars;
 *   • start < end, window length 1..370 days (annual windows — the
 *     benchmark's own shape; every strategy deposits at most once);
 *   • no OVERLAP with any existing period (windows partition time);
 *   • no two periods may START in the same calendar year (the ledger
 *     bucket must stay unique — split-year windows are a boundary concern
 *     the consumption phases own, not the bucket key);
 *   • CONTIGUITY: a period that starts the day after an existing one ends
 *     (or vice versa) is fine — that is the expected chain — but a period
 *     abutting nothing may only be the FIRST one or the NEXT one after
 *     the chain's end (a period may not start before the chain's last end
 *     unless it CONTAINS no gap... simplified: a new period must either
 *     start on/after the day after the latest end (forward extension) or
 *     end on/before the day before the earliest start (backward
 *     extension). Inserting into a gap would fork the chain).
 */
export function validateLeavePeriod(
  candidate: { name: string; startDate: string; endDate: string },
  existing: ReadonlyArray<LeavePeriodInput>,
): PeriodValidation {
  const name = candidate.name.trim();
  if (name.length === 0 || name.length > 80) {
    return { ok: false, reason: "Period name must be 1–80 characters." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.endDate)) {
    return { ok: false, reason: "Start and end dates must be YYYY-MM-DD." };
  }
  if (candidate.startDate >= candidate.endDate) {
    return { ok: false, reason: "The period must end after it starts." };
  }
  const len = daysBetween(candidate.startDate, candidate.endDate) + 1;
  if (len > 370) {
    return { ok: false, reason: `A leave period may span at most 370 days (this one spans ${len}).` };
  }
  const startYear = Number(candidate.startDate.slice(0, 4));
  for (const p of existing) {
    // Overlap: intervals [s1,e1] and [s2,e2] overlap iff s1 ≤ e2 && s2 ≤ e1.
    if (candidate.startDate <= p.endDate && p.startDate <= candidate.endDate) {
      return { ok: false, reason: `This window overlaps "${p.name}" (${p.startDate} → ${p.endDate}).` };
    }
    if (Number(p.startDate.slice(0, 4)) === startYear) {
      return {
        ok: false,
        reason: `"${p.name}" already starts in ${startYear} — one allocation window per start year keeps the ledger buckets unique.`,
      };
    }
  }
  // Chain extension: the candidate must attach to the chain's front or
  // back (or be the first period). A candidate floating inside a gap
  // forks the window chain.
  if (existing.length > 0) {
    const latestEnd = existing
      .map((p) => p.endDate)
      .sort()
      .at(-1)!;
    const earliestStart = existing
      .map((p) => p.startDate)
      .sort()
      .at(0)!;
    const extendsForward = candidate.startDate > latestEnd;
    const extendsBackward = candidate.endDate < earliestStart;
    if (!extendsForward && !extendsBackward) {
      return {
        ok: false,
        reason: "A new period must extend the chain (start after the latest end, or end before the earliest start) — it cannot float between existing windows.",
      };
    }
  }
  return { ok: true, reason: "" };
}

/** COMPLETE months of a window elapsed at asOf (0 in the window's first
 * month, 1 from the first day of its second month) — the
 * carryExpiresAfterMonths clock, window-relative (monthsIntoYear's
 * generalization; clamped at 0 so a pre-window asOf reads as 0). */
export function monthsIntoWindow(windowStart: string, asOf: string): number {
  return Math.max(0, monthsBetween(windowStart, asOf));
}
