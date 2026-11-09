// ---------------------------------------------------------------------------
// AT-B02/B03 (S2) — attendance timing facts as a pure kernel
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
//
// The benchmark's Attendance carries late-entry / early-exit flags and
// working hours computed against a shift's timing window. Fernly has no
// shifts (F3.5, declined for now), so the reference is the WORKSPACE
// DEFAULT DAY (Workspace.attendanceDayStart / attendanceDayEnd — policy as
// data: the knob is a DB row behind Settings → General, the rule is this
// clock-free, I/O-free function).
//
// Semantics (kept deliberately boring):
//   lateMinutes  = max(0, in  − dayStart)   — only when inTime is present
//   earlyMinutes = max(0, dayEnd − out)    — only when outTime is present
//   workingHours = (out − in) / 60          — only when BOTH are present
//                                                 and out > in (else null)
//   overtimeMinutes = max(0, out − dayEnd) — only when outTime is present
//                                                 (P9: the payroll bridge's
//                                                 input; minutes beyond the
//                                                 workspace day)
//   any absent input → that fact is null (not zero — "unknown", not "on
//   time"); a malformed reference time (bad config) disables the dependent
//   fact rather than throwing mid-mark (fail-soft for reads, the config
//   schema rejects bad values at write time anyway).
//
// Stored on the record at write time (derived-statuses discipline): the
// columns are never a form input; editing in/out recomputes them. A config
// change does NOT retro-rewrite history — existing rows keep the facts they
// were marked with, mirroring the F1.1 denormalized-denominator discipline.
// ---------------------------------------------------------------------------

/** Minutes since midnight for a "HH:MM" 24-hour string; null when absent or
 * malformed (no throw — callers decide what "unknown" means). */
export function parseHmToMinutes(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface AttendanceTimingFacts {
  /** Minutes past the day start (null = no in time / no valid reference). */
  lateMinutes: number | null;
  /** Minutes before the day end (null = no out time / no valid reference). */
  earlyMinutes: number | null;
  /** Hours between in and out, 2 decimals (null = incomplete pair). */
  workingHours: number | null;
  /** P9 (PR-B26) — minutes past the day end (null = no out time / no
   * valid reference); the payroll bridge sums these per period. */
  overtimeMinutes: number | null;
}

/** The one rule behind the late/early flags + working hours. */
export function deriveAttendanceTiming(input: {
  inTime?: string | null;
  outTime?: string | null;
  dayStart: string;
  dayEnd: string;
}): AttendanceTimingFacts {
  const dayStart = parseHmToMinutes(input.dayStart);
  const dayEnd = parseHmToMinutes(input.dayEnd);
  const inMin = parseHmToMinutes(input.inTime);
  const outMin = parseHmToMinutes(input.outTime);

  const lateMinutes =
    inMin !== null && dayStart !== null ? Math.max(0, inMin - dayStart) : null;
  const earlyMinutes =
    outMin !== null && dayEnd !== null ? Math.max(0, dayEnd - outMin) : null;
  const workingHours =
    inMin !== null && outMin !== null && outMin > inMin
      ? Math.round(((outMin - inMin) / 60) * 100) / 100
      : null;
  const overtimeMinutes =
    outMin !== null && dayEnd !== null ? Math.max(0, outMin - dayEnd) : null;

  return { lateMinutes, earlyMinutes, workingHours, overtimeMinutes };
}

/** Compact human rendering for tooltips/badges: 95 → "1h 35m". */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "Late 25m · Early 10m · 7h 55m" — the per-record facts line; empty string
 * when nothing is computable. */
export function describeAttendanceTiming(f: AttendanceTimingFacts): string {
  const parts: string[] = [];
  if (f.lateMinutes !== null && f.lateMinutes > 0) parts.push(`Late ${formatMinutes(f.lateMinutes)}`);
  if (f.earlyMinutes !== null && f.earlyMinutes > 0) parts.push(`Early ${formatMinutes(f.earlyMinutes)}`);
  if (f.workingHours !== null) parts.push(`${formatMinutes(Math.round(f.workingHours * 60))} worked`);
  if (f.overtimeMinutes !== null && f.overtimeMinutes > 0) parts.push(`OT ${formatMinutes(f.overtimeMinutes)}`);
  return parts.join(" · ");
}
