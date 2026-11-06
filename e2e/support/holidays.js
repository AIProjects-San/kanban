// F1.1 — e2e support: the seeded holiday calendar, mirrored from
// scripts/seed.js (NZ_PUBLIC_HOLIDAYS). The seed mirrors production math;
// this mirrors the seed so relative-date scenarios stay deterministic no
// matter which day CI runs: date helpers skip weeks that contain a holiday,
// and working-day walks count holidays exactly like the server
// (src/lib/working-days.ts).
//
// KEEP IN SYNC with scripts/seed.js when the seed's holiday table changes.

const HOLIDAY_DATES = new Set([
  // 2026
  "2026-01-01", "2026-01-02", "2026-02-06", "2026-04-03", "2026-04-06",
  "2026-04-27", "2026-06-01", "2026-07-10", "2026-10-26", "2026-12-25",
  "2026-12-28",
  // 2027
  "2027-01-01", "2027-01-04", "2027-02-08", "2027-03-26", "2027-03-29",
  "2027-04-26", "2027-06-07", "2027-06-25", "2027-10-25", "2027-12-27",
  "2027-12-28",
]);

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/** True when the UTC date is a seeded holiday (weekends are NOT holidays). */
function isHoliday(d) {
  return HOLIDAY_DATES.has(iso(d));
}

/** True when any day in [start, end] (inclusive, UTC) is a seeded holiday. */
function hasHolidayInRange(start, end) {
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    if (isHoliday(cursor)) return true;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
}

/**
 * Count working days in [start, end] with the SERVER's semantics: Mon–Fri,
 * holidays excluded. (Half-day entries are never seeded, so 0.5 never
 * appears in e2e date math.)
 */
function workingDaysBetween(start, end) {
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

module.exports = { isHoliday, hasHolidayInRange, workingDaysBetween, HOLIDAY_DATES };
