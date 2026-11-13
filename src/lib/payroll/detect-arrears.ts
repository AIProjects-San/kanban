// ---------------------------------------------------------------------------
// Phase 1B (G8, step 6) — ARREARS DETECTION (detect only, never post).
//
// A backdated revision re-prices every FUTURE run window, but windows that
// were already LOCKED were paid on the previous assignment's base. This
// helper surfaces the gap: one row per affected locked pay period with
// delta = (newBase − oldBase) ÷ windows-in-year, prorated to the period's
// working days the revision actually covers:
//
//   coverage = workingDays(max(periodStart, fromDate) … periodEnd)
//              ÷ run.workingDays
//
// The posting of adjustment lines is a LATER phase's decision — this module
// never writes anything.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { workingDaysBetween } from "@/lib/hr/working-days";
import { windowsInYear, type PayrollFrequency } from "@/lib/payroll/payroll-windows";
import { round2 } from "@/lib/payroll/payroll-math";
import { getHolidayLookup } from "@/lib/hr/holidays";



export interface ArrearsRow {
  periodStart: Date;
  periodEnd: Date;
  /** The run's period key ("2026-11", "2026-W45") for display. */
  periodKey: string;
  /** The annual base the period was PAID on. */
  paidBase: number;
  /** The annual base the period SHOULD have been paid on. */
  dueBase: number;
  /** (due − paid) prorated to the covered working days; may be negative. */
  delta: number;
}

/** Detect the locked windows a backdated revision leaves behind.
 *
 *  Affected = every LOCKED run containing a payslip for the employee whose
 *  window starts on/after the new assignment's fromDate (that window's pay
 *  should have come from the revision but was priced on the previous
 *  assignment — the runs were locked before the revision existed). */
export async function detectArrears(
  employeeId: string,
  newAssignmentId: string,
): Promise<ArrearsRow[]> {
  const revision = await db.salaryStructureAssignment.findUnique({
    where: { id: newAssignmentId },
  });
  if (!revision || revision.employeeId !== employeeId) return [];

  // The previous assignment (the one this revision closed) — the base the
  // locked windows were actually paid on.
  const previous = await db.salaryStructureAssignment.findFirst({
    where: {
      employeeId,
      fromDate: { lt: revision.fromDate },
    },
    orderBy: { fromDate: "desc" },
  });
  if (!previous) return [];

  const annualDelta = revision.base.toNumber() - previous.base.toNumber();
  if (Math.abs(annualDelta) < 0.005) return [];

  const runs = await db.payrollRun.findMany({
    where: {
      status: "LOCKED",
      // The previous assignment was in force at the run's start (the run
      // paid ITS base), and the run's window reaches into the revision's
      // reign — either fully (startDate on/after fromDate) or partially
      // (fromDate mid-window). Runs entirely before fromDate or before the
      // previous generation's start are not this revision's arrears.
      startDate: { gte: previous.fromDate },
      endDate: { gte: revision.fromDate },
      payslips: { some: { userId: employeeId } },
    },
    orderBy: { startDate: "asc" },
  });

  const out: ArrearsRow[] = [];
  for (const run of runs) {
    if (!run.startDate || !run.endDate) continue;
    const periodStart = run.startDate;
    const periodEnd = run.endDate;
    const frequency = (run.frequency || "MONTHLY") as PayrollFrequency;
    const perPeriod = annualDelta / windowsInYear(frequency, periodStart.getUTCFullYear());

    // The revision covers the part of the period from its fromDate; a
    // fromDate at/before the period start covers the whole window.
    const coverStart = revision.fromDate > periodStart ? revision.fromDate : periodStart;
    const holidays = await getHolidayLookup(coverStart, periodEnd);
    const coveredDays = workingDaysBetween(coverStart, periodEnd, holidays);
    const denominator = run.workingDays > 0
      ? run.workingDays
      : workingDaysBetween(periodStart, periodEnd, await getHolidayLookup(periodStart, periodEnd));
    if (denominator <= 0) continue;

    const delta = round2(perPeriod * (coveredDays / denominator));
    if (Math.abs(delta) < 0.005) continue;
    out.push({
      periodStart,
      periodEnd,
      periodKey: run.period,
      paidBase: previous.base.toNumber(),
      dueBase: revision.base.toNumber(),
      delta,
    });
  }
  return out;
}
