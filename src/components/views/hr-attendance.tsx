"use client";

// F1.3 — attendance records (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). The HR console's Attendance tab (attendance:manage — ADMIN + HR;
// the parent hr-view.tsx hides the tab otherwise and every action re-checks
// server-side). Monthly grid: one row per member, one column per day; HR
// marks a day by clicking a cell (empty → mark dialog, filled → edit
// dialog). ON_LEAVE cells are DERIVED from approved leave — read-only here
// unless HR explicitly overwrites them (which converts the row to MANUAL).
// Weekends and calendar holidays are shaded (F1.1 integration).

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { ATTENDANCE_STATUS_CODE, ATTENDANCE_STATUS_LABELS } from "@/lib/config";
import type { AttendanceT, AttendanceMonthT, AttendanceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { deriveAttendanceTiming, describeAttendanceTiming } from "@/lib/attendance-flags";
import { getAttendanceMonth, upsertAttendanceRecord, deleteAttendanceRecord, exportAttendanceSheetCsv } from "@/server-actions/hr-attendance";

/** Statuses HR may set from the form — ON_LEAVE is derived-only. */
const SETTABLE: Exclude<AttendanceStatus, "ON_LEAVE">[] = ["PRESENT", "ABSENT", "HALF_DAY", "WFH"];

const WEEKDAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];

function fmtMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function AttendanceTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [data, setData] = useState<AttendanceMonthT | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Prefill for the "mark" dialog: a member+day clicked in the grid (or null
  // for the header's generic "Mark a day" button, which shows the select).
  const [marking, setMarking] = useState<{ userId: string; date: string } | null>(null);
  const [editing, setEditing] = useState<AttendanceT | null>(null);
  // P32 (AT-R01) — the sheet export's busy flag.
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (y: number, m: number) => {
    const res = await getAttendanceMonth(y, m);
    if (res.ok) {
      setData(res.data);
    } else {
      toast.error(res.error);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(year, month); }, [load, year, month]);

  const onChanged = useCallback(async () => {
    await load(year, month);
  }, [load, year, month]);

  const daysInMonth = useMemo(
    () => new Date(Date.UTC(year, month, 0)).getUTCDate(),
    [year, month],
  );
  const days = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(Date.UTC(year, month - 1, i + 1));
      return { num: i + 1, iso: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
    }),
    [year, month, daysInMonth],
  );
  const holidayByDate = useMemo(
    () => new Map((data?.holidays ?? []).map((h) => [h.date, h.label])),
    [data],
  );
  const recordByUserDate = useMemo(() => {
    const map = new Map<string, AttendanceT>();
    for (const r of data?.records ?? []) map.set(`${r.userId}|${r.date}`, r);
    return map;
  }, [data]);

  const monthValue = `${year}-${String(month).padStart(2, "0")}`;

  // P32 (AT-R01) — the monthly attendance sheet CSV (the analytics Blob
  // pattern; the action builds the RFC 4180 file and audits the export like
  // every report CSV).
  const exportSheet = async () => {
    setExporting(true);
    const res = await exportAttendanceSheetCsv({ year, month });
    setExporting(false);
    if (!res.ok) { toast.error(res.error); return; }
    const blob = new Blob([res.data.csv], { type: res.data.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Attendance sheet for ${monthValue} exported (${res.data.filename}).`);
  };

  return (
    <div className="space-y-3" data-testid="hr-attendance">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <CalendarCheck size={14} /> Attendance — {fmtMonth(year, month)}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
            HR marks one record per person per day. Approved leave derives
            ON_LEAVE rows automatically; an explicit HR mark always wins.
            Weekends and holidays are shaded and never need marking.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            aria-label={`Previous month (${fmtMonth(...Object.values(shiftMonth(year, month, -1)) as [number, number])})`}
            onClick={() => { const s = shiftMonth(year, month, -1); setYear(s.year); setMonth(s.month); }}
          >
            <ChevronLeft size={14} />
          </button>
          <input
            id="att-month"
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
            aria-label={`Next month (${fmtMonth(...Object.values(shiftMonth(year, month, 1)) as [number, number])})`}
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
          <button
            type="button"
            className="f-btn f-btn-primary f-btn-sm"
            onClick={() => setMarking({ userId: "", date: "" })}
            data-testid="att-mark-button"
          >
            Mark a day
          </button>
          <button
            type="button"
            className="f-btn f-btn-secondary f-btn-sm"
            onClick={exportSheet}
            disabled={exporting}
            data-testid="att-sheet-export"
            aria-label={`Export the ${fmtMonth(year, month)} attendance sheet as CSV`}
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Sheet CSV
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap text-[0.6875rem] text-muted-foreground">
        {(["PRESENT", "ABSENT", "HALF_DAY", "WFH", "ON_LEAVE"] as AttendanceStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={cn("w-4 h-4 rounded-sm grid place-items-center font-semibold", statusCellClass(s))}>
              {ATTENDANCE_STATUS_CODE[s]}
            </span>
            {ATTENDANCE_STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      {/* Month grid */}
      {!loaded ? (
        <div className="text-sm text-muted-foreground">Loading attendance…</div>
      ) : (data?.members.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No members to mark.
        </div>
      ) : (
        <div className="f-card overflow-x-auto" data-testid="attendance-grid">
          <table className="text-sm tabular-nums" style={{ minWidth: 60 + daysInMonth * 26 }}>
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-3 py-2 font-semibold sticky left-0 bg-background z-10">Member</th>
                {days.map((d) => {
                  const holiday = holidayByDate.get(d.iso);
                  const weekend = d.weekday === 0 || d.weekday === 6;
                  return (
                    <th
                      key={d.iso}
                      className={cn("px-0.5 py-2 text-center font-semibold w-[26px]", (weekend || holiday) && "text-muted-foreground/70")}
                      title={holiday ? `${d.iso} — ${holiday}` : d.iso}
                    >
                      <div>{d.num}</div>
                      <div className="text-[0.5625rem] font-normal normal-case">{WEEKDAY_LETTER[d.weekday]}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(data?.members ?? []).map((m) => (
                <tr key={m.userId} className="border-b border-border last:border-0" data-testid="attendance-row" data-name={m.userName}>
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap sticky left-0 bg-background z-10 max-w-40 truncate" title={m.userName}>
                    {m.userName}
                  </td>
                  {days.map((d) => {
                    const rec = recordByUserDate.get(`${m.userId}|${d.iso}`);
                    const holiday = holidayByDate.get(d.iso);
                    const weekend = d.weekday === 0 || d.weekday === 6;
                    return (
                      <td key={d.iso} className={cn("px-0.5 py-1 text-center", (weekend || holiday) && "bg-muted/40")}>
                        <button
                          type="button"
                          data-testid="attendance-cell"
                          data-date={d.iso}
                          data-status={rec?.status ?? ""}
                          data-user={m.userName}
                          className={cn(
                            "w-[22px] h-[22px] rounded-sm grid place-items-center text-[0.625rem] font-semibold transition-colors",
                            rec ? statusCellClass(rec.status) : "text-muted-foreground/40 hover:bg-muted",
                          )}
                          title={
                            rec
                              ? `${m.userName} · ${d.iso} · ${ATTENDANCE_STATUS_LABELS[rec.status]}${rec.source === "DERIVED" ? " (derived from approved leave)" : ""}${rec.inTime ? ` · in ${rec.inTime}` : ""}${rec.outTime ? ` · out ${rec.outTime}` : ""}${describeAttendanceTiming(rec) ? ` · ${describeAttendanceTiming(rec)}` : ""}${rec.note ? ` · ${rec.note}` : ""}`
                              : holiday
                                ? `${d.iso} — ${holiday}`
                                : `${m.userName} · ${d.iso} — click to mark`
                          }
                          aria-label={`${m.userName} ${d.iso} ${rec ? ATTENDANCE_STATUS_LABELS[rec.status] : "not marked"}`}
                          onClick={() => (rec ? setEditing(rec) : setMarking({ userId: m.userId, date: d.iso }))}
                        >
                          {rec ? ATTENDANCE_STATUS_CODE[rec.status] : "·"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mark dialog (create) — prefill = the clicked cell (or blank). */}
      {(data?.members.length ?? 0) > 0 && (
        <AttendanceFormModal
          open={marking !== null}
          members={data?.members ?? []}
          prefill={marking}
          dayStart={data?.dayStart ?? "09:00"}
          dayEnd={data?.dayEnd ?? "17:30"}
          onClose={() => setMarking(null)}
          onChanged={onChanged}
        />
      )}

      {/* Edit dialog — prefill = the existing record; includes delete. */}
      {(data?.members.length ?? 0) > 0 && (
        <AttendanceFormModal
          open={editing !== null}
          members={data?.members ?? []}
          record={editing}
          dayStart={data?.dayStart ?? "09:00"}
          dayEnd={data?.dayEnd ?? "17:30"}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/** Compact cell coloring per status (grid + legend). */
function statusCellClass(status: AttendanceStatus): string {
  switch (status) {
    case "PRESENT": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "ABSENT": return "bg-red-500/15 text-red-700 dark:text-red-400";
    case "HALF_DAY": return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "WFH": return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
    case "ON_LEAVE": return "bg-violet-500/15 text-violet-700 dark:text-violet-400";
  }
}

function AttendanceFormModal({
  open, members, prefill, record, dayStart, dayEnd, onClose, onChanged,
}: {
  open: boolean;
  members: { userId: string; userName: string }[];
  /** Clicked-cell prefill (create mode) — userId/date may be "" for the generic button. */
  prefill?: { userId: string; date: string } | null;
  /** The record being edited (edit mode). */
  record?: AttendanceT | null;
  /** AT-B02/B03 (S2) — the workspace reference day; the modal live-previews
   * the late/early facts exactly as the server's pure kernel will store them. */
  dayStart?: string;
  dayEnd?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState<Exclude<AttendanceStatus, "ON_LEAVE">>("PRESENT");
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Re-seed the form whenever a different record/cell (or "new") opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserId(record?.userId ?? prefill?.userId ?? "");
    setDate(record?.date ?? prefill?.date ?? "");
    setStatus((record?.status && record.status !== "ON_LEAVE" ? record.status : "PRESENT") as Exclude<AttendanceStatus, "ON_LEAVE">);
    setInTime(record?.inTime ?? "");
    setOutTime(record?.outTime ?? "");
    setNote(record?.note ?? "");
  }, [record, prefill, open]);

  const targetName = record
    ? record.userName
    : members.find((m) => m.userId === userId)?.userName ?? "…";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !date) return;
    setBusy(true);
    const res = await upsertAttendanceRecord({
      ...(record ? { id: record.id } : {}),
      userId,
      date,
      status,
      inTime: inTime || null,
      outTime: outTime || null,
      note,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(record ? `Attendance updated — ${targetName}, ${date}` : `${targetName} marked ${status} on ${date}`);
      onClose();
      await onChanged();
    } else {
      toast.error(res.error);
    }
  };

  const remove = async () => {
    if (!record) return;
    setBusy(true);
    const res = await deleteAttendanceRecord({ id: record.id });
    setBusy(false);
    if (res.ok) {
      toast.success(`Removed ${targetName}'s record for ${date}`);
      onClose();
      await onChanged();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={record ? `Edit — ${targetName}, ${date}` : "Mark attendance"}
    >
      <form className="space-y-4" onSubmit={submit}>
        {record?.source === "DERIVED" && (
          <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-700 dark:text-violet-400">
            This ON_LEAVE record was derived from approved leave — saving an
            explicit mark replaces it (source becomes MANUAL).
          </div>
        )}
        <FormRow>
          <Field label="Member">
            {record ? (
              <input className="f-input" value={targetName} disabled readOnly />
            ) : (
              <select
                id="att-user"
                className="f-input"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
              >
                <option value="">Select a member…</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>{m.userName}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Date">
            <input
              id="att-date"
              type="date"
              className="f-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Status">
            <select
              id="att-status"
              className="f-input"
              value={status}
              onChange={(e) => setStatus(e.target.value as Exclude<AttendanceStatus, "ON_LEAVE">)}
            >
              {SETTABLE.map((s) => (
                <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="In (optional)">
              <input
                id="att-in"
                type="time"
                className="f-input"
                value={inTime}
                onChange={(e) => setInTime(e.target.value)}
              />
            </Field>
            <Field label="Out (optional)">
              <input
                id="att-out"
                type="time"
                className="f-input"
                value={outTime}
                onChange={(e) => setOutTime(e.target.value)}
              />
            </Field>
          </div>
        </FormRow>
        {/* AT-B02/B03 (S2) — live preview of the derived timing facts, the
            exact numbers the server's pure kernel will store (reference day:
            the workspace defaults). Blank when nothing is computable yet. */}
        {(inTime || outTime) && (
          <div
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            data-testid="att-timing-preview"
          >
            Reference day {dayStart ?? "09:00"}–{dayEnd ?? "17:30"} ·{" "}
            {describeAttendanceTiming(
              deriveAttendanceTiming({ inTime: inTime || null, outTime: outTime || null, dayStart: dayStart ?? "09:00", dayEnd: dayEnd ?? "17:30" }),
            ) || "no timing facts yet — enter in/out times"}
          </div>
        )}
        <Field label="Note (optional)">
          <input
            id="att-note"
            className="f-input"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Left early — dental appointment"
          />
        </Field>
        <div className="flex justify-end gap-2">
          {record && (
            <button
              type="button"
              className="f-btn f-btn-ghost f-btn-sm text-destructive mr-auto"
              onClick={remove}
              disabled={busy}
              data-testid="att-delete"
            >
              <Trash2 size={13} /> Remove record
            </button>
          )}
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy || !userId || !date}>
            {busy ? "Saving…" : record ? "Save changes" : "Mark day"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
