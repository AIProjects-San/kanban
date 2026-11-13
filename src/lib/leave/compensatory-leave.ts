// P30 (LV-01/LV-11, L10) — compensatory leave, pure core
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 item P30).
//
// The worked-holiday day walk the benchmark's `Compensatory Leave Request`
// validation runs: every claimed day must be a NON-working day (a weekend or
// a full holiday-calendar entry — half-day holidays are working half-days,
// exactly the nonWorkingDayReason classification), and attendance must show
// the member actually worked it (PRESENT/WFH = a whole comp day, HALF_DAY =
// half of one — the F1.1 quarter-day fractions stay first-class). ABSENT,
// ON_LEAVE and unmarked days refuse the claim naming the date.
//
// Pure and dependency-free so BOTH sides import it:
//   • server actions — createCompensatoryLeaveRequest validates the claim at
//     submission, and decideCompensatoryLeaveRequest re-validates the SAME
//     facts inside its approval transaction (the QA-1 discipline: attendance
//     may have been corrected between submission and decision);
//   • the ESS claim form — the live preview walks the range against the
//     holiday map (attendance facts are the server's to judge; the preview
//     shows the walk and lets the server refuse);
//   • unit tests — the full matrix lives here, not in mocks.
//
// All dates are UTC-midnight "YYYY-MM-DD" day keys.

import { nonWorkingDayReason, type HolidayLookup } from "@/lib/working-days";

import { round2 } from "@/lib/payroll/payroll-math";
import { parseDay } from "@/lib/working-days";



function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One refused day of a claim: the date and the humanized reason. */
export interface CompDayProblem {
  date: string;
  reason: string;
}

/** The day walk's verdict: the earned days and every refused day. */
export interface CompDayWalk {
  days: number;
  problems: CompDayProblem[];
}

/** Attendance statuses that count as having worked the claimed day.
 * PRESENT and WFH are working states (a whole comp day each); HALF_DAY is
 * half of one. Everything else — ABSENT, ON_LEAVE, or no row at all —
 * refused the claim for that date (the benchmark requires Present marks;
 * WFH/HALF_DAY ride the house's attendance semantics). */
const WORKED_STATUS_DAYS: Record<string, number> = {
  PRESENT: 1,
  WFH: 1,
  HALF_DAY: 0.5,
};

const DAY = 86_400_000;

/**
 * Walk [workFrom, workTo] day by day and price the compensatory claim:
 * each non-working day with worked attendance earns its days, each working
 * day or unworked day is a problem. A claim with ANY problem is invalid —
 * the caller refuses it naming the dates (the benchmark validates every
 * date in the span, not a best-effort subset).
 */
export function earnedCompDays(input: {
  workFrom: string;
  workTo: string;
  holidays: HolidayLookup | undefined;
  attendanceByDay: ReadonlyMap<string, string>;
}): CompDayWalk {
  const problems: CompDayProblem[] = [];
  let days = 0;
  const start = parseDay(input.workFrom);
  const end = parseDay(input.workTo);
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const d = new Date(t);
    const key = dayStr(d);
    const hol = input.holidays?.get(key);
    const nonWorking = nonWorkingDayReason(d, hol ? { label: "", isHalfDay: hol.isHalfDay } : undefined);
    if (!nonWorking) {
      problems.push({
        date: key,
        reason: "is a working day — comp-off claims only cover weekends and holidays",
      });
      continue;
    }
    const status = input.attendanceByDay.get(key);
    const earned = status != null ? WORKED_STATUS_DAYS[status] : undefined;
    if (earned === undefined) {
      problems.push({
        date: key,
        reason:
          status == null
            ? "has no attendance marked — ask HR to mark you worked first"
            : `shows ${status.replace("_", " ").toLowerCase()} attendance — the day wasn't worked`,
      });
      continue;
    }
    days += earned;
  }
  return { days: round2(days), problems };
}

/**
 * The ESS preview's mirror of the day count WITHOUT attendance facts: how
 * many claimed non-working days the span holds (weekends + full holidays;
 * half-day holidays and working days are not claimable). The server's
 * verdict may still refuse days attendance disagrees with — the preview
 * says how many days the claim WOULD earn if attendance checks out.
 */
export function claimedNonWorkingDays(
  workFrom: string,
  workTo: string,
  holidays: HolidayLookup | undefined,
): number {
  const start = parseDay(workFrom);
  const end = parseDay(workTo);
  let count = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const d = new Date(t);
    const key = dayStr(d);
    const hol = holidays?.get(key);
    const nonWorking = nonWorkingDayReason(
      d,
      hol ? { label: "", isHalfDay: hol.isHalfDay } : undefined,
    );
    if (nonWorking) count += 1;
  }
  return count;
}
