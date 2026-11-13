// SERVER-ONLY holiday-calendar reads.
//
// Lives in lib so the payroll kernels (detect-arrears, the IRD filing
// service) and the leave engine read the SAME holiday rows the actions do —
// one query shape, one caching story.

import { db } from "@/lib/infra/db";
import { holidayLookupFrom, type HolidayLookup } from "@/lib/hr/working-days";

/** The compact holiday lookup for a date range: date-key → half-day flag.
 *  Rows are date-only UTC-midnight values, so inclusive gte/lte bounds on
 *  the same convention match exactly. */
export async function getHolidayLookup(start: Date, end: Date): Promise<HolidayLookup> {
  const rows = await db.holidayCalendarEntry.findMany({
    where: { date: { gte: start, lte: end } },
    select: { date: true, isHalfDay: true },
  });
  return holidayLookupFrom(rows);
}
