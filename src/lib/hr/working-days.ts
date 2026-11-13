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
/** UTC midnight for a "YYYY-MM-DD" string. A malformed string throws —
 *  a bad date must fail loudly, not become NaN day arithmetic. */
export function parseDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid date: ${day}`);
  }
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${day}`);
  }
  return d;
}

/** Whole calendar days from a to b (negative when b precedes a). Accepts
 *  Date or "YYYY-MM-DD" — strings parse as UTC midnight. */
export function daysBetween(a: Date | string, b: Date | string): number {
  const ta = typeof a === "string" ? parseDay(a).getTime() : a.getTime();
  const tb = typeof b === "string" ? parseDay(b).getTime() : b.getTime();
  return Math.round((tb - ta) / 86_400_000);
}

/** The day key n days away from a day key. */
export function addDays(day: string, n: number): string {
  return dayKey(new Date(parseDay(day).getTime() + n * 86_400_000));
}

/** Add whole months with end-of-month clamping (Jan 31 + 1 → Feb 28/29). */
export function addMonths(day: string, n: number): string {
  const d = parseDay(day);
  const targetY = d.getUTCFullYear();
  const targetM = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return dayKey(new Date(Date.UTC(targetY, targetM, Math.min(d.getUTCDate(), lastDay))));
}

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

/**
 * P35 (EM-12) — the holiday-aware FORWARD walk: the date `n` working days
 * after `start` (the onboarding/separation task due date). Skips weekends
 * and full holiday-calendar entries; half-day holidays count as working
 * days (dayKind's "markable" rule). `n <= 0` returns `start` unchanged —
 * the caller's own day-0 semantics (a task due "day 0" is due the day the
 * checklist starts, whatever kind of day that is; the template schema's
 * min(1) keeps the walk honest for template rows).
 *
 * The counterpart of workingDaysBetween (count) — this one ADVANCES.
 */
export function addWorkingDays(
  start: Date,
  n: number,
  holidays?: HolidayLookup,
): Date {
  const cursor = new Date(start.getTime());
  let remaining = Math.floor(n);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const kind = dayKind(cursor, holidays?.get(dayKey(cursor)));
    // Only real working days decrement the walk — WEEKEND and FULL_HOLIDAY
    // are skipped; HALF_HOLIDAY counts (the dayKind "markable" rule).
    if (kind === "WORKING" || kind === "HALF_HOLIDAY") {
      remaining -= 1;
    }
  }
  return cursor;
}

/**
 * P32 (AT-R01) — the day-kind classifier: "WEEKEND", "FULL_HOLIDAY",
 * "HALF_HOLIDAY" or "WORKING" for one UTC-midnight date. Pure; the caller
 * supplies the calendar row (if any). ONE rule for every surface that
 * needs the classification (the F-R15 marking guard's reason strings, the
 * P32 attendance-sheet export's WO/H cell codes) — nonWorkingDayReason
 * below is its message rendering, and the sheet cell codes are its code
 * rendering, so the three can never drift.
 */
export type NonWorkingDayKind = "WEEKEND" | "FULL_HOLIDAY" | "HALF_HOLIDAY" | "WORKING";

export function dayKind(
  d: Date,
  holiday?: { label?: string; isHalfDay: boolean } | null,
): NonWorkingDayKind {
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  if (dow === 0 || dow === 6) return "WEEKEND";
  if (holiday && !holiday.isHalfDay) return "FULL_HOLIDAY";
  if (holiday && holiday.isHalfDay) return "HALF_HOLIDAY";
  return "WORKING";
}

/**
 * F-R15 (S3) — why a date is NOT markable for attendance, or null when it
 * is a working day. Pure: the caller supplies the calendar row (if any).
 * Half-day holidays ARE working (half) days — marking stays allowed; the
 * S2 timing facts and the F1.4 LOP derivation handle their halfness.
 * P32: the message rendering of the dayKind classifier above.
 */
export function nonWorkingDayReason(
  d: Date,
  holiday?: { label?: string; isHalfDay: boolean } | null,
): string | null {
  switch (dayKind(d, holiday)) {
    case "WEEKEND":
      return d.getUTCDay() === 0 ? "a Sunday" : "a Saturday";
    case "FULL_HOLIDAY":
      return `a holiday (${holiday?.label ?? "holiday"})`;
    default:
      return null; // WORKING and HALF_HOLIDAY are both markable
  }
}

/**
 * PR-B06 (S5) — the payment window of a "YYYY-MM" period for one employee:
 * working days in [max(period start, hireDate), min(period end, LWD)].
 * Pure; the caller supplies the holiday lookup and the employment dates.
 * `paidDays` is the holiday-aware count inside the window (half-day
 * holidays 0.5); `clippedFrom/Until` tell the UI which ends bit. Absent
 * employment dates = the unbounded full-period window (paidDays equals
 * workingDaysInPeriod).
 */
export function paymentWindow(
  period: string,
  holidays: HolidayLookup | undefined,
  employment?: { from?: Date | string | null; until?: Date | string | null },
): { paidDays: number; windowStart: Date; windowEnd: Date; clippedFrom: boolean; clippedUntil: boolean } {
  const [y, m] = period.split("-").map(Number);
  const periodStart = new Date(Date.UTC(y || 1970, (m || 1) - 1, 1));
  const periodEnd = new Date(Date.UTC(y || 1970, m || 1, 0));
  return paymentWindowBetween(periodStart, periodEnd, holidays, employment);
}

/**
 * P10 (PR-B05) — the same payment window for an arbitrary payroll window
 * [start, end] (any cadence — weekly runs, bimonthly halves, single days):
 * working days in [max(window start, hireDate), min(window end, LWD)].
 * paymentWindow(monthly) delegates here, so the two can never drift.
 */
export function paymentWindowBetween(
  periodStart: Date,
  periodEnd: Date,
  holidays: HolidayLookup | undefined,
  employment?: { from?: Date | string | null; until?: Date | string | null },
): { paidDays: number; windowStart: Date; windowEnd: Date; clippedFrom: boolean; clippedUntil: boolean } {
  const from = employment?.from != null
    ? (employment.from instanceof Date ? employment.from : new Date(`${employment.from}T00:00:00.000Z`))
    : null;
  const until = employment?.until != null
    ? (employment.until instanceof Date ? employment.until : new Date(`${employment.until}T00:00:00.000Z`))
    : null;
  const windowStart = from && from > periodStart ? from : periodStart;
  const windowEnd = until && until < periodEnd ? until : periodEnd;
  const paidDays = windowStart <= windowEnd
    ? workingDaysBetween(windowStart, windowEnd, holidays)
    : 0;
  return {
    paidDays,
    windowStart,
    windowEnd,
    clippedFrom: Boolean(from && from > periodStart),
    clippedUntil: Boolean(until && until < periodEnd),
  };
}
