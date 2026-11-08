// F1.4 — attendance→LOP derivation, pure core
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
//
// Pure and dependency-light (only working-days.ts) so BOTH sides import it:
//   • server actions — createPayrollRun/addPayslip pre-compute each
//     payslip's lopDays at run creation (src/server-actions/payroll.ts);
//   • unit tests — the full derivation matrix lives here, not in mocks.
// The seed mirrors this walk in scripts/seed.js ("seed mirrors production
// math").
//
// Semantics (per working day of the "YYYY-MM" period):
//   • Weekends (Sat/Sun UTC) and full holiday-calendar entries never charge.
//     Half-day holiday entries have a working fraction of 0.5.
//   • An APPROVED leave request covering the day wins over attendance:
//       – unpaid type (LeaveType.paid = false) → charges the working
//         fraction (an unpaid-leave day is docked in full);
//       – paid type → charges 0 — an authorized paid absence can never also
//         be docked through an ABSENT mark (no double charge, and a
//         contradictory HR mark on a paid-leave day cannot silently cut pay).
//   • Otherwise the attendance mark decides: ABSENT → working fraction,
//     HALF_DAY → half the working fraction (0.5 on a normal day, 0.25 on a
//     half-day holiday), PRESENT/WFH/ON_LEAVE/no record → 0. Records on
//     non-working days are ignored (attendance accepts marks on any date —
//     F-R15; the payroll side only ever charges working days).
//   • PR-B07 (S4) — `unmarkedMode: "ABSENT"` charges UNMARKED working days
//     (no record, no leave) as absent — the benchmark's
//     consider_unmarked_attendance_as knob as workspace data. Default
//     IGNORED = absence of data is not absence (the honest reading of a
//     manual-marking system). Any record — including PRESENT/WFH/ON_LEAVE —
//     counts as "marked"; only a truly missing day charges.
//   • Employment window (hireDate → lastWorkingDay): days OUTSIDE the
//     window never charge (marks, leave, or unmarked) — pre-hire and
//     post-exit days are not loss of pay. Absent inputs = unbounded window
//     (the S5 payment-day clipping formalizes the gross-side mirror).
//   • The sum is rounded to 2 decimals to kill float dust.
//
// Unmarked-mode days (PR-B07, S4): with unmarkedMode "ABSENT", a working
// day with no record and no leave inside the employment window charges as
// absent; with the default IGNORED, absence of data is not absence (the
// honest reading of a manual-marking system — no auto-absent sweep).
//
// All dates are UTC-midnight date-only values; inputs accept Date or
// "YYYY-MM-DD" strings defensively (the LeaveRequest.startDate convention).

import { dayKey, type HolidayLookup } from "@/lib/working-days";

/** One attendance record that can charge LOP (ABSENT / HALF_DAY). */
export interface LopAttendanceMark {
  date: Date | string;
  status: string;
}

/** One approved leave span with its type's paid flag. */
export interface LopLeaveSpan {
  startDate: Date | string;
  endDate: Date | string;
  paid: boolean;
}

/** PR-B07 (S4) — the workspace knob + the employment window. All optional;
 * omitted = the pre-S4 semantics byte-for-byte. */
export interface DeriveLopOptions {
  /** Treat unmarked working days as ABSENT (default IGNORED). */
  unmarkedMode?: "IGNORED" | "ABSENT";
  /** First employment day (EmployeeProfile.hireDate); null/absent = unbounded. */
  employmentFrom?: Date | string | null;
  /** Last employment day (EmployeeProfile.lastWorkingDay); null/absent = unbounded. */
  employmentUntil?: Date | string | null;
}

function asUtcDay(d: Date | string): Date {
  return d instanceof Date ? d : new Date(`${d}T00:00:00.000Z`);
}

/** The working fraction of a day: 1 (normal weekday), 0.5 (half-day
 * holiday), 0 (weekend or full holiday). */
function workingFraction(d: Date, holidays?: HolidayLookup): number {
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  if (dow === 0 || dow === 6) return 0;
  const hol = holidays?.get(dayKey(d));
  if (!hol) return 1;
  return hol.isHalfDay ? 0.5 : 0;
}

/**
 * Derive the loss-of-pay days for one employee over a "YYYY-MM" period.
 * `marks` are that employee's attendance records in the period (only
 * ABSENT/HALF_DAY are chargeable — callers may pre-filter, but other
 * statuses are ignored here too); `leaveSpans` are that employee's approved
 * leave requests overlapping the period, tagged with the leave type's paid
 * flag. Returns a possibly-fractional day count (0.5 steps; 0.25 on
 * half-day holidays), rounded to 2 decimals.
 */
export function deriveLopDays(
  period: string,
  holidays: HolidayLookup | undefined,
  marks: LopAttendanceMark[],
  leaveSpans: LopLeaveSpan[],
  opts: DeriveLopOptions = {},
): number {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return 0;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // day 0 = last day of previous month
  const empFrom = opts.employmentFrom != null ? asUtcDay(opts.employmentFrom) : null;
  const empUntil = opts.employmentUntil != null ? asUtcDay(opts.employmentUntil) : null;

  const markByDay = new Map<string, string>();
  for (const mark of marks) {
    markByDay.set(dayKey(asUtcDay(mark.date)), mark.status);
  }
  const spans = leaveSpans.map((s) => ({
    start: asUtcDay(s.startDate),
    end: asUtcDay(s.endDate),
    paid: s.paid,
  }));

  let total = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const wf = workingFraction(cursor, holidays);
    // Employment window (S4/S5): days outside [hireDate, lastWorkingDay]
    // never charge — pre-hire and post-exit days are not loss of pay.
    const inWindow =
      (empFrom === null || cursor >= empFrom) &&
      (empUntil === null || cursor <= empUntil);
    if (wf > 0 && inWindow) {
      const span = spans.find((s) => cursor >= s.start && cursor <= s.end);
      if (span) {
        // Approved leave wins over attendance marks (see header).
        if (!span.paid) total += wf;
      } else {
        const status = markByDay.get(dayKey(cursor));
        if (status === "ABSENT") total += wf;
        else if (status === "HALF_DAY") total += wf / 2;
        else if (status === undefined && opts.unmarkedMode === "ABSENT") {
          // PR-B07 (S4) — no record and no leave on a working day inside
          // the employment window: the workspace counts it as absent.
          total += wf;
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.round(total * 100) / 100;
}
