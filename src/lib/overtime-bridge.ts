// ---------------------------------------------------------------------------
// P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge, pure computation
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 9).
//
// The benchmark's Overtime machinery (Overtime Type + Overtime Slip with
// standard/weekend/holiday multipliers and caps) is shift-based — declined
// with shifts (F3.5). This is the LITE bridge riding the facts Fernly
// already derives: AttendanceRecord.overtimeMinutes (the S2 kernel —
// minutes beyond the workspace default day, snapshotted at write time).
//
// THE RULE (kept deliberately boring):
//   hourly rate  = structure's UNSCALED monthly gross ÷ run working days ÷ 8
//   amount       = Σ period minutes / 60 × hourly rate, rounded once
//   the line     = one "Overtime" EARNING on the payslip, materialized at
//                  run/slip creation like the auto LOP line (snapshot
//                  discipline: attendance edits after creation are
//                  corrections, not silent re-derivations)
//
// The line lands AFTER the LOP basis on purpose: overtime minutes were
// worked on attended days, so absence-based docking never touches them
// (the S6 window-exemption spirit).
//
// HONESTY RULES
//   • The payout knob (Workspace.overtimePayEnabled) defaults OFF — overtime
//     pay is a policy choice, never a surprise payslip line.
//   • No minutes, no computable rate → NO line (null plan), never a $0 line
//     pretending the employee worked overtime.
//   • The label shows its own work: hours and the rate it used.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";
import { formatMinutes } from "@/lib/attendance-flags";

/** The payslip line's stable key (mirrors the auto LOP line's "lop"). */
export const OVERTIME_LINE_KEY = "overtime";

/** Hours in a standard working day — the gross-basis divisor. The benchmark
 * derives this from shift timings; without shifts the honest constant is 8. */
export const STANDARD_DAY_HOURS = 8;

/** Gross-basis hourly rate: monthly gross ÷ working days ÷ 8h, rounded once.
 * 0 when uncomputable (no gross, non-positive denominator) — the caller's
 * notes/absence explain why, the number stays honest. */
export function overtimeHourlyRate(monthlyGross: number | null, workingDays: number): number {
  if (monthlyGross === null || !(monthlyGross > 0) || !(workingDays > 0)) return 0;
  return round2(monthlyGross / workingDays / STANDARD_DAY_HOURS);
}

export interface OvertimePayout {
  /** Σ the period's derived overtime minutes. */
  minutes: number;
  /** minutes / 60, 2 decimals — shown on the line label. */
  hours: number;
  hourlyRate: number;
  /** hours × rate, rounded once. */
  amount: number;
}

/** Plan the payout for one employee's period total. null = no line (the
 * knob is off, no minutes, or no computable rate — never a fake zero). */
export function planOvertimePayout(input: {
  enabled: boolean;
  /** Σ AttendanceRecord.overtimeMinutes over the run's period. */
  minutes: number | null;
  /** The structure's UNSCALED monthly gross. */
  monthlyGross: number | null;
  workingDays: number;
}): OvertimePayout | null {
  if (!input.enabled) return null;
  const minutes = input.minutes !== null && Number.isFinite(input.minutes) && input.minutes > 0
    ? Math.round(input.minutes)
    : 0;
  if (minutes === 0) return null;
  const hourlyRate = overtimeHourlyRate(input.monthlyGross, input.workingDays);
  if (hourlyRate <= 0) return null;
  const hours = Math.round((minutes / 60) * 100) / 100;
  return { minutes, hours, hourlyRate, amount: round2(hours * hourlyRate) };
}

/** The earning line's label — its own work shown: "Overtime — 2h 30m at $36.90/h". */
export function overtimeLineLabel(payout: OvertimePayout): string {
  return `Overtime — ${formatMinutes(payout.minutes)} at $${payout.hourlyRate.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/h`;
}

/** Σ non-null overtime minutes per user over the period's records. */
export function sumOvertimeMinutes(
  records: Array<{ userId: string; overtimeMinutes: number | null }>,
): Map<string, number> {
  const byUser = new Map<string, number>();
  for (const r of records) {
    if (r.overtimeMinutes === null || !(r.overtimeMinutes > 0)) continue;
    byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + r.overtimeMinutes);
  }
  return byUser;
}
