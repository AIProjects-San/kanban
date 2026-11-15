// ---------------------------------------------------------------------------
// G4 — the shift + roster kernel (the pure clock math every side imports:
// the shift master CRUD, the roster grid, the absence detection).
//
// Shifts are EXPECTED hours (the roster says who should be there when);
// timesheets + attendance carry ACTUAL hours. The two never mix in one
// number — the roster informs absence detection (assigned but unmarked =
// ABSENT) and, later, shift differentials; it never writes payroll.
//
// Clock times are "HH:mm" strings (the AttendanceRecord inTime/outTime
// convention). Overnight shifts (endTime <= startTime) cross midnight —
// their span pays out over two calendar days, which is exactly why
// AttendanceRecord.shiftAssignmentId is one-to-many.
// ---------------------------------------------------------------------------

import { dayKey } from "@/lib/hr/working-days";

export const SHIFT_ASSIGNMENT_STATUSES = [
  "SCHEDULED",
  "COMPLETED",
  "ABSENT",
  "SWAPPED",
] as const;
export type ShiftAssignmentStatus = (typeof SHIFT_ASSIGNMENT_STATUSES)[number];

export const SHIFT_ASSIGNMENT_STATUS_LABELS: Record<ShiftAssignmentStatus, string> = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  ABSENT: "Absent (no attendance)",
  SWAPPED: "Swapped",
};

export const SHIFT_ASSIGNMENT_STATUS_BADGE: Record<ShiftAssignmentStatus, string> = {
  SCHEDULED: "bg-sky-500/10 text-sky-700",
  COMPLETED: "bg-emerald-500/10 text-emerald-700",
  ABSENT: "bg-destructive/10 text-destructive",
  SWAPPED: "bg-violet-500/10 text-violet-700",
};

// ---------------------------------------------------------------------------
// Clock math
// ---------------------------------------------------------------------------

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:00" → 540 minutes since midnight. Returns null for garbage. */
export function parseClockTime(value: string): number | null {
  const m = CLOCK_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidClockTime(value: string): boolean {
  return parseClockTime(value) != null;
}

/** An overnight shift ends on the next calendar day (22:00 → 06:00). */
export function shiftIsOvernight(startTime: string, endTime: string): boolean {
  const s = parseClockTime(startTime);
  const e = parseClockTime(endTime);
  if (s == null || e == null) return false;
  return e <= s;
}

/** The paid span in minutes: |end − start| (+24h when overnight), minus
 * the unpaid break. null when the clock strings are unparsable or the
 * break exceeds the span. */
export function shiftDurationMinutes(input: {
  startTime: string;
  endTime: string;
  breakMinutes?: number | null;
}): number | null {
  const s = parseClockTime(input.startTime);
  const e = parseClockTime(input.endTime);
  if (s == null || e == null) return null;
  const br = Math.max(0, Math.floor(input.breakMinutes ?? 0));
  let span = e - s;
  if (span <= 0) span += 24 * 60; // overnight (a zero span is a full day — refused by validation)
  const paid = span - br;
  return paid > 0 ? paid : null;
}

/** The shift's expected hours (the roster's "expected" column). */
export function shiftExpectedHours(input: {
  startTime: string;
  endTime: string;
  breakMinutes?: number | null;
}): number | null {
  const mins = shiftDurationMinutes(input);
  return mins == null ? null : Math.round((mins / 60) * 100) / 100;
}

/** The validation twin (the pure guard for tests and non-zod callers). */
export function isValidShiftInput(input: {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}): string | null {
  if (!input.name.trim()) return "The shift needs a name.";
  if (!isValidClockTime(input.startTime)) return "The start time must be a valid HH:mm clock time.";
  if (!isValidClockTime(input.endTime)) return "The end time must be a valid HH:mm clock time.";
  const s = parseClockTime(input.startTime)!;
  const e = parseClockTime(input.endTime)!;
  if (s === e) return "The start and end times cannot be the same.";
  if (shiftDurationMinutes(input) == null) {
    return "The unpaid break cannot be longer than the shift's span.";
  }
  if (!(input.breakMinutes >= 0) || input.breakMinutes > 240) {
    return "The unpaid break must be between 0 and 240 minutes.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Roster math
// ---------------------------------------------------------------------------

/** The roster conflict predicate: one employee, one day, one slot. The
 * DB's @@unique([employeeId, rosterDate]) is the hard guard; this is the
 * friendly pre-check the actions (and the grid UI) surface. */
export function findRosterConflict(
  assignments: Array<{ employeeId: string; rosterDay: string }>,
  employeeId: string,
  rosterDay: string,
): { employeeId: string; rosterDay: string } | null {
  return assignments.find(
    (a) => a.employeeId === employeeId && a.rosterDay === rosterDay,
  ) ?? null;
}

/** Absence candidates: SCHEDULED slots whose day carries no attendance
 * mark for that employee (§4 — assigned but no attendance = absent). The
 * caller supplies the marked (employeeId, day) pairs; pure means testable. */
export function absenceCandidates(
  assignments: Array<{ id: string; employeeId: string; rosterDay: string; status: string }>,
  markedDays: Set<string>,
): Array<{ id: string; employeeId: string; rosterDay: string }> {
  return assignments
    .filter((a) => a.status === "SCHEDULED" && !markedDays.has(`${a.employeeId}|${a.rosterDay}`))
    .map(({ id, employeeId, rosterDay }) => ({ id, employeeId, rosterDay }));
}

/** The roster grid's day key helper (UTC ISO day of a date). */
export function rosterDayKey(d: Date): string {
  return dayKey(d);
}
