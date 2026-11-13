"use client";

// F1.3 — attendance self-service read (docs/Fernly_HR_Payroll_Enhancement_
// Plan.md §7.1). Every role reads their OWN month (getMyAttendance — the
// session-scoped convention, zero member inputs). Members never write
// attendance (decision §9.1): the view has no marking surface at all and
// says so — corrections go to HR, who owns every record.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { ATTENDANCE_STATUS_BADGE, ATTENDANCE_STATUS_LABELS } from "@/lib/config";
import type { AttendanceT, AttendanceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { describeAttendanceTiming, formatMinutes } from "@/lib/hr/attendance-flags";
import { getMyAttendance } from "@/server-actions/hr-attendance";
// The attendance list shows weekday + day + month only ("Wed 25 Dec") —
// a variant of the shared day formatter, composed here.
function fmtAttendanceDay(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Calendar cells (Monday-first): leading blanks + one cell per day. */
function monthCells(year: number, month: number) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // getUTCDay(): 0=Sun..6=Sat → Monday-first column index.
  const firstCol = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: ({ day: number; iso: string; weekend: boolean } | null)[] = [];
  for (let i = 0; i < firstCol; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = new Date(Date.UTC(year, month - 1, d));
    cells.push({
      day: d,
      iso: date.toISOString().slice(0, 10),
      weekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
    });
  }
  return cells;
}

export function MyAttendanceView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [records, setRecords] = useState<AttendanceT[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (y: number, m: number) => {
    const res = await getMyAttendance(y, m);
    if (res.ok) {
      setRecords(res.data.records);
    } else {
      toast.error(res.error);
      setRecords([]);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(year, month); }, [load, year, month]);

  const byDate = useMemo(() => new Map(records.map((r) => [r.date, r])), [records]);
  const cells = useMemo(() => monthCells(year, month), [year, month]);

  const counts = useMemo(() => {
    const c: Record<AttendanceStatus, number> = { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, WFH: 0, ON_LEAVE: 0 };
    for (const r of records) c[r.status] += 1;
    return c;
  }, [records]);

  const monthValue = `${year}-${String(month).padStart(2, "0")}`;

  return (
    <div className="p-6 space-y-5" data-testid="my-attendance-view">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <CalendarCheck size={20} /> My Attendance
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {records.length > 0
              ? `${records.length} marked day${records.length === 1 ? "" : "s"} in ${fmtMonth(year, month)} · ${currentUser.name}`
              : `No marked days in ${fmtMonth(year, month)} yet · ${currentUser.name}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            aria-label="Previous month"
            onClick={() => { const s = shiftMonth(year, month, -1); setYear(s.year); setMonth(s.month); }}
          >
            <ChevronLeft size={14} />
          </button>
          <input
            id="my-att-month"
            type="month"
            className="f-input w-36"
            value={monthValue}
            onChange={(e) => {
              const [y, m] = e.target.value.split("-").map(Number);
              if (y && m) { setYear(y); setMonth(m); }
            }}
            aria-label="Attendance month"
          />
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            aria-label="Next month"
            onClick={() => { const s = shiftMonth(year, month, 1); setYear(s.year); setMonth(s.month); }}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="f-btn f-btn-secondary f-btn-sm"
            onClick={() => {
              const t = new Date();
              setYear(t.getUTCFullYear());
              setMonth(t.getUTCMonth() + 1);
            }}
          >
            Today
          </button>
        </div>
      </div>

      {/* Summary chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["PRESENT", "WFH", "HALF_DAY", "ABSENT", "ON_LEAVE"] as AttendanceStatus[]).map((s) => (
          <span
            key={s}
            data-testid={`my-att-count-${s}`}
            className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium", ATTENDANCE_STATUS_BADGE[s])}
          >
            {ATTENDANCE_STATUS_LABELS[s]} <span className="tabular-nums font-semibold">{counts[s]}</span>
          </span>
        ))}
      </div>

      {/* Calendar */}
      <div className="rounded-lg border border-border overflow-hidden" data-testid="my-att-calendar">
        <div className="grid grid-cols-7 border-b border-border bg-muted/30">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5 text-center text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            if (!cell) return <div key={`blank-${i}`} className="min-h-16 border-b border-r border-border bg-muted/20" />;
            const rec = byDate.get(cell.iso);
            return (
              <div
                key={cell.iso}
                data-testid="my-att-day"
                data-date={cell.iso}
                data-status={rec?.status ?? ""}
                className={cn(
                  "min-h-16 border-b border-r border-border p-1.5 flex flex-col gap-1",
                  cell.weekend && "bg-muted/20",
                )}
              >
                <div className="text-xs text-muted-foreground tabular-nums">{cell.day}</div>
                {rec && (
                  <span
                    className={cn("inline-flex px-1.5 py-0.5 rounded text-[0.625rem] font-medium w-fit", ATTENDANCE_STATUS_BADGE[rec.status])}
                    title={`${ATTENDANCE_STATUS_LABELS[rec.status]}${rec.source === "DERIVED" ? " (from approved leave)" : ""}${rec.inTime ? ` · in ${rec.inTime}` : ""}${rec.outTime ? ` · out ${rec.outTime}` : ""}${describeAttendanceTiming(rec) ? ` · ${describeAttendanceTiming(rec)}` : ""}${rec.note ? ` · ${rec.note}` : ""}`}
                  >
                    {ATTENDANCE_STATUS_LABELS[rec.status]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Marked days list (notes + times live here — calendar cells only
          carry the status chip). */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <CalendarCheck size={14} className="text-primary" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Marked days — {fmtMonth(year, month)}
          </div>
        </div>
        {!loaded ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        ) : records.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            Nothing marked for this month yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {records.map((r) => (
              <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-sm" data-testid="my-att-record" data-date={r.date}>
                <span className="text-xs text-muted-foreground w-28 shrink-0">{fmtAttendanceDay(r.date)}</span>
                <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium", ATTENDANCE_STATUS_BADGE[r.status])}>
                  {ATTENDANCE_STATUS_LABELS[r.status]}
                </span>
                {r.source === "DERIVED" && (
                  <span className="text-[0.625rem] text-violet-600 dark:text-violet-400">from approved leave</span>
                )}
                {(r.inTime || r.outTime) && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {r.inTime ?? "—"} → {r.outTime ?? "—"}
                  </span>
                )}
                {/* AT-B02/B03 (S2) — the derived timing facts as honest badges:
                    late/early only when they actually happened, hours worked
                    whenever the pair is complete. */}
                {r.lateMinutes !== null && r.lateMinutes > 0 && (
                  <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400" data-testid="my-att-late">
                    Late {formatMinutes(r.lateMinutes)}
                  </span>
                )}
                {r.earlyMinutes !== null && r.earlyMinutes > 0 && (
                  <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-400" data-testid="my-att-early">
                    Early {formatMinutes(r.earlyMinutes)}
                  </span>
                )}
                {r.workingHours !== null && (
                  <span className="text-[0.625rem] text-muted-foreground tabular-nums" data-testid="my-att-hours">
                    {formatMinutes(Math.round(r.workingHours * 60))} worked
                  </span>
                )}
                {r.note && (
                  <span className="text-xs text-muted-foreground truncate" title={r.note}>{r.note}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Attendance is recorded by HR — including WFH and on-leave days. Contact
        HR for corrections; there is no self-marking.
      </p>
    </div>
  );
}
