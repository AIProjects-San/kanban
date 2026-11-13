// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the 2-working-day filing deadline.
//
// Tax Administration Act 1994 s 23D(4): an electronic filer must file the
// Employment Information return within TWO WORKING DAYS after the payday
// (paper filers get 10; unsupported here). IRD's file upload spec adds:
// "If the due date falls on a weekend or public holiday (excluding a
// provincial anniversary day), then the due date becomes the next working
// day" — which is exactly the Phase 1A working-days kernel's semantics
// (weekends + the holiday calendar; the seeded calendar carries national
// holidays only, no regional anniversaries, matching IRD's rule).
//
// Pure date math — the DB-driven overdue flagging lives in the filing
// service.
// ---------------------------------------------------------------------------

import { addWorkingDays, dayKey, type HolidayLookup } from "@/lib/hr/working-days";

/** The statutory filing window (electronic filers). */
export const FILING_WORKING_DAYS = 2;

function isWorkingDay(d: Date, holidays?: HolidayLookup): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const hol = holidays?.get(dayKey(d));
  if (hol && !hol.isHalfDay) return false;
  return true;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * payDate + 2 working days, skipping weekends and holiday-calendar
 * entries. The walk starts strictly AFTER the payday (a Friday payday is
 * due the following Tuesday; a payday before a public holiday shifts the
 * due date past it).
 */
export function computeDueDate(payDate: Date, holidays?: HolidayLookup): Date {
  return addWorkingDays(payDate, FILING_WORKING_DAYS, holidays);
}

/**
 * Working days from `from` (exclusive) to `due` (inclusive) — the UI's
 * countdown figure. 0 means the deadline day itself; negative values
 * count the working days the filing is already late (working days
 * strictly after `due`, up to and including `from` — a weekend check
 * adds no lateness).
 */
export function workingDaysRemaining(from: Date, due: Date, holidays?: HolidayLookup): number {
  const start = utcMidnight(from).getTime();
  const end = utcMidnight(due).getTime();
  const countBetween = (a: number, b: number): number => {
    // Working days in (a, b] — both UTC midnights, a < b.
    const cursor = new Date(a);
    let count = 0;
    while (cursor.getTime() < b) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isWorkingDay(cursor, holidays)) count += 1;
    }
    return count;
  };
  if (end >= start) return countBetween(start, end);
  const late = countBetween(end, start);
  return late === 0 ? 0 : -late; // never return -0
}
