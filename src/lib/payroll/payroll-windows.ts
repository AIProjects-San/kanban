// ---------------------------------------------------------------------------
// P10 (PR-B05 + PR-03's payroll_frequency) — the payroll-windows kernel.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep.
//
// Every payroll cadence as ONE pure, dependency-free calendar so BOTH sides
// import it (server actions resolve runs; the run-creation modal previews
// the window live):
//
//   • resolvePayrollWindow(frequency, anchorDate) — the window containing
//     the anchor: {start, end, periodKey, label}. The period KEY is the
//     unique human identifier stored on PayrollRun (its uniqueness is what
//     keeps one run per window).
//   • parsePayrollPeriodKey(key) — the exact inverse: any stored key maps
//     back to its window, so period-string comparisons elsewhere become
//     DATE comparisons (correct across cadences; byte-identical for the
//     monthly keys that predate P10).
//   • windowsInYear(frequency, year) — the divisor for per-cadence amounts
//     (annual ÷ windows), Frappe-faithful: a structure's amounts pay once
//     per window of its cadence.
//
// Cadence semantics (the Frappe five from hrms get_start_end_dates, plus
// the two house extras named in the plan row):
//   MONTHLY     calendar month                     key "2026-11"        (unchanged — every pre-P10 row)
//   BIMONTHLY   calendar halves 1–15 / 16–end      key "2026-11-A"/"-B" (Frappe's Bimonthly exactly)
//   WEEKLY      ISO-8601 week, Mon–Sun             key "2026-W45"       (Frappe anchors at the entry start; ISO weeks are the deterministic house calendar)
//   FORTNIGHTLY pair of ISO weeks (2k-1, 2k)       key "2026-F23"       (Frappe's is start→start+13 anchored anywhere; ISO pairs never split a week — 53-week years end with a one-week F27)
//   DAILY       the single anchor day              key "2026-11-09"     (Frappe's Daily exactly)
//   QUARTERLY   calendar quarter                   key "2026-Q4"        (house extra)
//   ANNUAL      calendar year                      key "2026"           (house extra)
//
// YTD year attribution (house rule, used by the read paths): a window
// belongs to the calendar year its END date falls in — identical to the
// old period-key year for every monthly row; a "2026-W53" ending Jan 3
// counts toward 2027.
//
// No I/O, no clock, no db — pure functions over UTC-midnight dates.
// ---------------------------------------------------------------------------

export type PayrollFrequency =
  | "MONTHLY"
  | "BIMONTHLY"
  | "WEEKLY"
  | "FORTNIGHTLY"
  | "DAILY"
  | "QUARTERLY"
  | "ANNUAL";

/** Zod-enum-friendly literal tuple (validation.ts reuses it). */
/** Narrow a stored frequency string to the union (unknown/legacy values
 *  collapse to MONTHLY, the historical default). */
export function parsePayrollFrequency(value: string | null | undefined): PayrollFrequency {
  return (PAYROLL_FREQUENCY_VALUES as readonly string[]).includes(value ?? "")
    ? (value as PayrollFrequency)
    : "MONTHLY";
}

export const PAYROLL_FREQUENCY_VALUES = [
  "MONTHLY",
  "BIMONTHLY",
  "WEEKLY",
  "FORTNIGHTLY",
  "DAILY",
  "QUARTERLY",
  "ANNUAL",
] as const;

/** UI picker rows: value + one-line hint. */
export const PAYROLL_FREQUENCY_OPTIONS: Array<{ value: PayrollFrequency; label: string; hint: string }> = [
  { value: "MONTHLY", label: "Monthly", hint: "calendar month (the default)" },
  { value: "BIMONTHLY", label: "Bimonthly", hint: "twice a month — 1st–15th / 16th–end" },
  { value: "WEEKLY", label: "Weekly", hint: "ISO week, Monday–Sunday" },
  { value: "FORTNIGHTLY", label: "Fortnightly", hint: "two ISO weeks" },
  { value: "DAILY", label: "Daily", hint: "single day" },
  { value: "QUARTERLY", label: "Quarterly", hint: "calendar quarter" },
  { value: "ANNUAL", label: "Annual", hint: "calendar year" },
];

export interface PayrollWindow {
  frequency: PayrollFrequency;
  /** UTC midnight, inclusive. */
  start: Date;
  /** UTC midnight, inclusive. */
  end: Date;
  /** The unique period key stored on PayrollRun (display + uniqueness). */
  periodKey: string;
  /** Human label for lists and modals. */
  label: string;
}

const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function utc(year: number, monthIndex0: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex0, day));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

/** Normalize an anchor (Date or "YYYY-MM-DD") to its UTC midnight. Invalid → null. */
function toUtcMidnight(anchor: Date | string): Date | null {
  if (anchor instanceof Date) {
    if (Number.isNaN(anchor.getTime())) return null;
    return utc(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor.trim());
  if (!m) return null;
  const d = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject "2026-02-30"-style impossibilities (Date overflows silently).
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

// ---------------------------------------------------------------------------
// ISO-8601 week calendar (WEEKLY + FORTNIGHTLY)
// ---------------------------------------------------------------------------

/** The Monday of the ISO week containing Jan 4 of `year` (ISO week 1). */
function isoWeekOneMonday(year: number): Date {
  const jan4 = utc(year, 0, 4);
  const dow = jan4.getUTCDay(); // 0 Sun … 6 Sat
  return addDays(jan4, -((dow + 6) % 7)); // back up to Monday
}

/** The Monday of the given day's ISO week. */
function mondayOf(d: Date): Date {
  const dow = d.getUTCDay();
  return addDays(d, -((dow + 6) % 7));
}

/** The Monday of ISO `week` (1-based) of `isoYear`. */
function isoWeekMonday(isoYear: number, week: number): Date {
  return addDays(isoWeekOneMonday(isoYear), (week - 1) * 7);
}

function isoWeeksInYear(isoYear: number): number {
  return Math.round(dayDiff(isoWeekOneMonday(isoYear + 1), isoWeekOneMonday(isoYear)) / 7);
}

/** A day's ISO year + week number (boundary-safe: late-Dec days can belong
 * to next year's W1; early-Jan days to the previous year's W52/W53). */
function isoYearAndWeek(d: Date): { isoYear: number; week: number } {
  const y = d.getUTCFullYear();
  const thisW1 = isoWeekOneMonday(y);
  if (d.getTime() < thisW1.getTime()) {
    const prevW1 = isoWeekOneMonday(y - 1);
    return { isoYear: y - 1, week: Math.floor(dayDiff(d, prevW1) / 7) + 1 };
  }
  const nextW1 = isoWeekOneMonday(y + 1);
  if (d.getTime() >= nextW1.getTime()) {
    return { isoYear: y + 1, week: 1 };
  }
  return { isoYear: y, week: Math.floor(dayDiff(d, thisW1) / 7) + 1 };
}

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

function shortDate(d: Date): string {
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Resolve the payroll window containing `anchor` for one cadence.
 * Pure; invalid anchors return null. */
export function resolvePayrollWindow(frequency: PayrollFrequency, anchor: Date | string): PayrollWindow | null {
  const d = toUtcMidnight(anchor);
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;

  if (frequency === "MONTHLY") {
    const start = utc(y, m - 1, 1);
    const end = utc(y, m, 0);
    return {
      frequency,
      start,
      end,
      periodKey: `${y}-${pad2(m)}`,
      label: `${MONTH_NAMES[m - 1]} ${y}`,
    };
  }

  if (frequency === "BIMONTHLY") {
    const firstHalf = d.getUTCDate() <= 15;
    const start = firstHalf ? utc(y, m - 1, 1) : utc(y, m - 1, 16);
    const end = firstHalf ? utc(y, m - 1, 15) : utc(y, m, 0);
    return {
      frequency,
      start,
      end,
      periodKey: `${y}-${pad2(m)}-${firstHalf ? "A" : "B"}`,
      label: `${MONTH_NAMES[m - 1]} ${y} · ${firstHalf ? "first" : "second"} half`,
    };
  }

  if (frequency === "WEEKLY") {
    const { isoYear, week } = isoYearAndWeek(mondayOf(d));
    const start = isoWeekMonday(isoYear, week);
    const end = addDays(start, 6);
    return {
      frequency,
      start,
      end,
      periodKey: `${isoYear}-W${pad2(week)}`,
      label: `Week ${week}, ${isoYear} (${shortDate(start)} – ${shortDate(end)})`,
    };
  }

  if (frequency === "FORTNIGHTLY") {
    const { isoYear, week } = isoYearAndWeek(mondayOf(d));
    const fn = Math.ceil(week / 2);
    const weeks = isoWeeksInYear(isoYear);
    const start = isoWeekMonday(isoYear, 2 * fn - 1);
    // 53-week years: the final fortnight is week 53 alone (7 days).
    const end = 2 * fn <= weeks ? addDays(isoWeekMonday(isoYear, 2 * fn), 6) : addDays(start, 6);
    return {
      frequency,
      start,
      end,
      periodKey: `${isoYear}-F${pad2(fn)}`,
      label: `Fortnight ${fn}, ${isoYear} (${shortDate(start)} – ${shortDate(end)})`,
    };
  }

  if (frequency === "DAILY") {
    return {
      frequency,
      start: d,
      end: d,
      periodKey: `${y}-${pad2(m)}-${pad2(d.getUTCDate())}`,
      label: `${MONTH_SHORT[m - 1]} ${d.getUTCDate()}, ${y}`,
    };
  }

  if (frequency === "QUARTERLY") {
    const q = Math.floor((m - 1) / 3) + 1;
    const start = utc(y, 3 * (q - 1), 1);
    const end = utc(y, 3 * q, 0);
    return {
      frequency,
      start,
      end,
      periodKey: `${y}-Q${q}`,
      label: `Q${q} ${y} (${MONTH_SHORT[3 * (q - 1)]} – ${MONTH_SHORT[3 * q - 1]})`,
    };
  }

  // ANNUAL
  return {
    frequency,
    start: utc(y, 0, 1),
    end: utc(y, 11, 31),
    periodKey: `${y}`,
    label: `${y} (Jan – Dec)`,
  };
}

// ---------------------------------------------------------------------------
// Key parsing (the inverse)
// ---------------------------------------------------------------------------

/** Parse a stored period key back into its window — the inverse of
 * resolvePayrollWindow. Recognizes every cadence's format plus the
 * pre-P10 monthly keys. Unknown/unparseable keys → null (callers treat
 * them as incomparable, never as January). */
export function parsePayrollPeriodKey(key: string): PayrollWindow | null {
  const k = String(key ?? "").trim();
  if (!k) return null;

  let m = /^(\d{4})$/.exec(k);
  if (m) return resolvePayrollWindow("ANNUAL", `${k}-01-01`);

  m = /^(\d{4})-Q([1-4])$/.exec(k);
  if (m) return resolvePayrollWindow("QUARTERLY", `${m[1]}-${pad2(3 * (Number(m[2]) - 1) + 1)}-01`);

  m = /^(\d{4})-W(\d{2})$/.exec(k);
  if (m) {
    const isoYear = Number(m[1]);
    const week = Number(m[2]);
    if (week >= 1 && week <= isoWeeksInYear(isoYear)) {
      return resolvePayrollWindow("WEEKLY", isoWeekMonday(isoYear, week));
    }
    return null;
  }

  m = /^(\d{4})-F(\d{2})$/.exec(k);
  if (m) {
    const isoYear = Number(m[1]);
    const fn = Number(m[2]);
    const maxFn = Math.ceil(isoWeeksInYear(isoYear) / 2);
    if (fn >= 1 && fn <= maxFn) {
      return resolvePayrollWindow("FORTNIGHTLY", isoWeekMonday(isoYear, 2 * fn - 1));
    }
    return null;
  }

  m = /^(\d{4})-(0[1-9]|1[0-2])-([AB])$/.exec(k);
  if (m) {
    const day = m[3] === "A" ? "01" : "16";
    return resolvePayrollWindow("BIMONTHLY", `${m[1]}-${m[2]}-${day}`);
  }

  m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(k);
  if (m) return resolvePayrollWindow("MONTHLY", `${m[1]}-${m[2]}-01`);

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (m) return resolvePayrollWindow("DAILY", k);

  return null;
}

/** A key's window-start instant (ms), or null when unparseable — the
 * primitive every period comparison funnels through. */
export function periodStartMs(key: string): number | null {
  return parsePayrollPeriodKey(key)?.start.getTime() ?? null;
}

/** A key's window-end instant (ms), or null when unparseable. */
export function periodEndMs(key: string): number | null {
  return parsePayrollPeriodKey(key)?.end.getTime() ?? null;
}

// ---------------------------------------------------------------------------
// Amounts: the per-cadence divisor
// ---------------------------------------------------------------------------

/** How many windows the cadence produces in a calendar year — the divisor
 * turning ANNUAL structure amounts into per-window amounts (Frappe parity:
 * amounts are periodic per the structure's frequency). 53-week ISO years
 * genuinely have 53 weekly windows (weekly employees earn slightly more in
 * those years — the benchmark's own behavior); the trailing lone week makes
 * 27 fortnights. */
export function windowsInYear(frequency: PayrollFrequency, year: number): number {
  switch (frequency) {
    case "MONTHLY":
      return 12;
    case "BIMONTHLY":
      return 24;
    case "WEEKLY":
      return isoWeeksInYear(year);
    case "FORTNIGHTLY":
      return Math.ceil(isoWeeksInYear(year) / 2);
    case "DAILY":
      return Math.round(dayDiff(utc(year + 1, 0, 1), utc(year, 0, 1)));
    case "QUARTERLY":
      return 4;
    case "ANNUAL":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Fiscal year (P16 / PR-11)
// ---------------------------------------------------------------------------

/** Resolve the fiscal year a date falls in, given the month the fiscal
 * year STARTS (1–12; 1 = calendar year). The return value is the year the
 * fiscal year starts in — e.g. with startMonth 4, Dec 2026 → 2026 (the FY
 * that began Apr 2026) while Feb 2027 → 2026 too (both inside Apr 2026 –
 * Mar 2027); Jan–Dec of a calendar year map to themselves at startMonth 1.
 * Out-of-range months clamp to the calendar-year answer (defensive — the
 * write path validates 1–12). */
export function fiscalYearOf(ms: number, startMonth: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (!Number.isFinite(startMonth) || startMonth <= 1 || startMonth > 12) return y;
  return m < startMonth ? y - 1 : y;
}

/** The [start, end) ms bounds of one fiscal year (end = the NEXT fiscal
 * year's start — exclusive, so membership tests are two comparisons). */
export function fiscalYearBounds(
  startYear: number,
  startMonth: number,
): { startMs: number; endMs: number } {
  const m = Math.min(Math.max(Math.round(startMonth), 1), 12);
  const start = Date.UTC(startYear, m - 1, 1);
  const end = Date.UTC(startYear + 1, m - 1, 1);
  return { startMs: start, endMs: end };
}

/** Human label for a fiscal year: "2026" when it is the calendar year, or
 * "2026/27" style when it spans two (the payslip modal's YTD chip). */
export function fiscalYearLabel(startYear: number, startMonth: number): string {
  if (!Number.isFinite(startMonth) || startMonth <= 1 || startMonth > 12) {
    return String(startYear);
  }
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Human label for any stored period key (falls back to the raw key). */
export function payrollPeriodLabel(key: string): string {
  return parsePayrollPeriodKey(key)?.label ?? key;
}

/** The end-of-window date for a run row: the stored endDate column when
 * present, else the parsed key (pre-P10 rows / defensive fallback). */
export function runWindowEnd(period: string, endDate?: Date | string | null): Date | null {
  if (endDate != null) {
    const d = endDate instanceof Date ? endDate : new Date(endDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return parsePayrollPeriodKey(period)?.end ?? null;
}

/** The start-of-window date for a run row (same fallback rule). */
export function runWindowStart(period: string, startDate?: Date | string | null): Date | null {
  if (startDate != null) {
    const d = startDate instanceof Date ? startDate : new Date(startDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return parsePayrollPeriodKey(period)?.start ?? null;
}
