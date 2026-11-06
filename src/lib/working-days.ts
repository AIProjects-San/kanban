// F1.1 — holiday-aware working-day math (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). Pure and dependency-free so BOTH sides import it:
//   • server actions (hr-leave day counting, payroll run denominators)
//   • client components (the Leave view's live request preview)
//
// Semantics (house decision, mirrors the LeaveRequest.days convention):
//   • Weekends (Sat/Sun UTC) never count.
//   • A holiday-calendar entry on a weekday removes it from the count;
//     isHalfDay entries count 0.5.
//   • kind (PUBLIC/WEEKLY_OFF) is labeling only — both kinds are excluded.
//   • Entries on a weekend change nothing (the day already counts 0).
//
// All dates are UTC-midnight date-only values; the key format is "yyyy-mm-dd"
// so Date↔string round-trips (toISOString().slice(0, 10)) are stable.

export interface HolidayDay {
  isHalfDay: boolean;
}

/** Lookup keyed by "yyyy-mm-dd" — build from HolidayCalendarEntry rows. */
export type HolidayLookup = Map<string, HolidayDay>;

/** "yyyy-mm-dd" for a UTC-midnight date. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build a HolidayLookup from rows shaped like holiday-calendar entries. */
export function holidayLookupFrom(
  rows: Array<{ date: Date | string; isHalfDay: boolean }>,
): HolidayLookup {
  const map: HolidayLookup = new Map();
  for (const r of rows) {
    const d = r.date instanceof Date ? r.date : new Date(`${r.date}T00:00:00.000Z`);
    map.set(dayKey(d), { isHalfDay: r.isHalfDay });
  }
  return map;
}

/**
 * Count working days in [start, end] inclusive: Mon–Fri, minus holiday
 * entries (half-day entries count 0.5). Returns a possibly-fractional count.
 */
export function workingDaysBetween(start: Date, end: Date, holidays?: HolidayLookup): number {
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) {
      const hol = holidays?.get(dayKey(cursor));
      if (!hol) count += 1;
      else if (hol.isHalfDay) count += 0.5;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Working days in a "YYYY-MM" payroll period (the LOP denominator source).
 * Holidays may span month boundaries in the lookup — only the period's days
 * are read, so callers can safely pass a wider range's entries.
 */
export function workingDaysInPeriod(period: string, holidays?: HolidayLookup): number {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return 0;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // day 0 = last day of previous month
  return workingDaysBetween(start, end, holidays);
}
