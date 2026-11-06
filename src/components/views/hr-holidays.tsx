"use client";

// F1.1 — HR console tab: the workspace holiday calendar
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1). hr:admin only — the
// parent tab renders it behind the same canAdmin gate as Types & Policies.
//
// Semantics reminder (shown in the header): every entry removes its date
// from working-day counting (half days count 0.5); PUBLIC vs WEEKLY_OFF is
// labeling. Leave requests and payroll runs DENORMALIZE the count at
// creation — editing the calendar never rewrites history.

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field } from "../ui/field";
import type { HolidayT } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  getHolidayCalendar,
  upsertHolidayEntry,
  deleteHolidayEntry,
} from "@/server-actions/hr-holidays";

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

const KIND_LABEL: Record<HolidayT["kind"], string> = {
  PUBLIC: "Public holiday",
  WEEKLY_OFF: "Weekly off",
};

export function HolidaysTab() {
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const [entries, setEntries] = useState<HolidayT[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<HolidayT | null>(null);

  const load = useCallback(async (y: number) => {
    const res = await getHolidayCalendar(y);
    if (res.ok) {
      setEntries(res.data.entries);
    } else {
      toast.error(res.error);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(year); }, [load, year]);

  const thisYear = new Date().getUTCFullYear();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <CalendarDays size={14} className="text-pink-500" /> Holiday calendar
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
            Entries remove the date from working-day counting (half days count 0.5) —
            for leave requests and payroll denominators created from now on.
            Existing requests and runs keep their denormalized counts.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            onClick={() => setYear((y) => y - 1)}
            aria-label={`Previous year (${year - 1})`}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-foreground tabular-nums min-w-[3.5rem] text-center">
            {year}
          </span>
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            onClick={() => setYear((y) => y + 1)}
            aria-label={`Next year (${year + 1})`}
          >
            <ChevronRight size={14} />
          </button>
          {year !== thisYear && (
            <button
              type="button"
              className="f-btn f-btn-ghost f-btn-sm"
              onClick={() => setYear(thisYear)}
            >
              Today
            </button>
          )}
          <button
            type="button"
            className="f-btn f-btn-primary f-btn-sm"
            onClick={() => { setEditing(null); setShowForm(true); }}
          >
            <Plus size={14} /> Add holiday
          </button>
        </div>
      </div>

      {!loaded ? (
        <div className="text-sm text-muted-foreground">Loading calendar…</div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No holiday entries in {year}. Without entries, working days are
          simply Monday–Friday.
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
          {entries.map((h) => (
            <div key={h.id} data-testid="holiday-row" className="flex items-center gap-3 px-3 py-2.5">
              <div className="w-40 shrink-0 text-sm text-foreground tabular-nums">
                {fmtDay(h.date)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground truncate">{h.label || "—"}</div>
                <div className="text-[0.6875rem] text-muted-foreground flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-sm px-1 py-px text-[0.5625rem] font-semibold uppercase tracking-wide",
                      h.kind === "PUBLIC"
                        ? "bg-pink-500/10 text-pink-600"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {KIND_LABEL[h.kind]}
                  </span>
                  {h.isHalfDay && <span>half day (counts 0.5)</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="f-btn f-btn-ghost f-btn-sm"
                  onClick={() => { setEditing(h); setShowForm(true); }}
                  aria-label={`Edit ${h.label || h.date}`}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="f-btn f-btn-ghost f-btn-sm text-destructive"
                  onClick={async () => {
                    const res = await deleteHolidayEntry({ id: h.id });
                    if (res.ok) {
                      toast.success(`Removed ${h.label || h.date}`);
                      await load(year);
                    } else {
                      toast.error(res.error);
                    }
                  }}
                  aria-label={`Delete ${h.label || h.date}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <HolidayFormModal
        open={showForm}
        entry={editing}
        onClose={() => setShowForm(false)}
        onChanged={async () => { await load(year); }}
      />
    </div>
  );
}

function HolidayFormModal({
  open,
  entry,
  onClose,
  onChanged,
}: {
  open: boolean;
  entry: HolidayT | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [date, setDate] = useState(entry?.date ?? "");
  const [label, setLabel] = useState(entry?.label ?? "");
  const [kind, setKind] = useState<HolidayT["kind"]>(entry?.kind ?? "PUBLIC");
  const [isHalfDay, setIsHalfDay] = useState(entry?.isHalfDay ?? false);
  const [busy, setBusy] = useState(false);

  // Re-seed the form whenever a different entry (or "new") opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDate(entry?.date ?? "");
    setLabel(entry?.label ?? "");
    setKind(entry?.kind ?? "PUBLIC");
    setIsHalfDay(entry?.isHalfDay ?? false);
  }, [entry, open]);

  return (
    <Modal open={open} onClose={onClose} title={entry ? `Edit ${entry.label || entry.date}` : "Add holiday"}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await upsertHolidayEntry({
            ...(entry ? { id: entry.id } : {}),
            date,
            label,
            kind,
            isHalfDay,
          });
          setBusy(false);
          if (res.ok) {
            toast.success(entry ? "Holiday updated" : "Holiday added");
            onClose();
            await onChanged();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <Field label="Date">
          <input
            id="hol-date"
            type="date"
            className="f-input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Label">
          <input
            id="hol-label"
            className="f-input"
            value={label}
            maxLength={80}
            placeholder="e.g. Waitangi Day"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <select
            id="hol-kind"
            className="f-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as HolidayT["kind"])}
          >
            <option value="PUBLIC">Public holiday</option>
            <option value="WEEKLY_OFF">Weekly off / company off day</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            id="hol-half"
            type="checkbox"
            checked={isHalfDay}
            onChange={(e) => setIsHalfDay(e.target.checked)}
            className="h-4 w-4"
          />
          Half day (counts 0.5 working days)
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy}>
            {busy ? "Saving…" : entry ? "Save changes" : "Add holiday"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
