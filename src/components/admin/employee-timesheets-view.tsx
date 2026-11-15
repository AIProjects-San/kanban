"use client";

// ---------------------------------------------------------------------------
// G4 — one employee's timesheets: the list with status + totals, and the
// draft editor (full line replace — one document per window, re-saving
// rewrites the draft). The owner self-serves (isSelf); HR opens any
// employee's page and drafts on their behalf. Submitting locks the draft
// into the review queue; the decision happens on /admin/timesheets (or
// here, server-side four-eyes applies either way).
// ---------------------------------------------------------------------------

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ClipboardList,
  Loader2,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { saveTimesheet, submitTimesheet, getTimesheetDetail } from "@/server-actions/timesheets";
import type { TimesheetT } from "@/lib/types";
import {
  TIMESHEET_STATUS_BADGE,
  TIMESHEET_STATUS_LABELS,
  isEditableTimesheet,
} from "@/lib/hr/timesheets";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface DraftLine {
  key: string;
  workDate: string;
  hours: string;
  projectId: string;
  description: string;
  isBillable: boolean;
  isOvertime: boolean;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthBounds(day: string): { start: string; end: string } {
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` };
}

export function EmployeeTimesheetsView({
  employee,
  sheets,
  isSelf,
}: {
  employee: { id: string; name: string; email: string };
  sheets: TimesheetT[];
  isSelf: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  // The editor state (opened by "New timesheet" or "Edit draft").
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState(monthBounds(todayStr()).start);
  const [periodEnd, setPeriodEnd] = useState(monthBounds(todayStr()).end);
  const [lines, setLines] = useState<DraftLine[]>([]);

  const openNew = () => {
    const b = monthBounds(todayStr());
    setEditingId(null);
    setPeriodStart(b.start);
    setPeriodEnd(b.end);
    setLines([
      { key: crypto.randomUUID(), workDate: todayStr(), hours: "8", projectId: "", description: "", isBillable: false, isOvertime: false },
    ]);
    setEditorOpen(true);
  };

  const openEdit = (sheet: TimesheetT) => {
    setBusy(true);
    startTransition(async () => {
      const res = await getTimesheetDetail({ timesheetId: sheet.id });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEditingId(sheet.id);
      setPeriodStart(res.data.periodStart);
      setPeriodEnd(res.data.periodEnd);
      setLines(
        res.data.lines.map((l) => ({
          key: crypto.randomUUID(),
          workDate: l.workDate,
          hours: String(l.hours),
          projectId: l.projectId ?? "",
          description: l.description ?? "",
          isBillable: l.isBillable,
          isOvertime: l.isOvertime,
        })),
      );
      setEditorOpen(true);
    });
  };

  const draftTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number.parseFloat(l.hours) || 0), 0),
    [lines],
  );

  const addLine = () => {
    setLines((ls) => [
      ...ls,
      { key: crypto.randomUUID(), workDate: lines[ls.length - 1]?.workDate ?? todayStr(), hours: "8", projectId: "", description: "", isBillable: false, isOvertime: false },
    ]);
  };

  const save = (thenSubmit: boolean) => {
    setBusy(true);
    const payload = {
      employeeId: employee.id,
      periodStart,
      periodEnd,
      lines: lines
        .filter((l) => l.workDate && Number.parseFloat(l.hours) > 0)
        .map((l) => ({
          workDate: l.workDate,
          hours: Number.parseFloat(l.hours),
          ...(l.projectId.trim() ? { projectId: l.projectId.trim() } : {}),
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
          isBillable: l.isBillable,
          isOvertime: l.isOvertime,
        })),
    };
    startTransition(async () => {
      const res = await saveTimesheet(payload);
      if (!res.ok) {
        setBusy(false);
        toast.error(res.error);
        return;
      }
      toast.success(`Draft saved — ${res.data.totalHours.toFixed(2)} h across ${payload.lines.length} line(s).`);
      if (thenSubmit) {
        const sub = await submitTimesheet({ timesheetId: res.data.id });
        setBusy(false);
        if (!sub.ok) {
          toast.error(sub.error);
          return;
        }
        toast.success("Submitted for review.");
      } else {
        setBusy(false);
      }
      setEditorOpen(false);
      router.refresh();
    });
  };

  const submitExisting = (sheet: TimesheetT) => {
    setBusy(true);
    startTransition(async () => {
      const res = await submitTimesheet({ timesheetId: sheet.id });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Submitted for review.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="employee-timesheets-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList size={20} /> {isSelf ? "My timesheets" : `${employee.name}'s timesheets`}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isSelf
              ? "Draft your actual hours per day, submit for review, and follow the approval."
              : `${employee.email} · HR may draft on the employee's behalf; approval stays four-eyes.`}
          </p>
        </div>
        <button className="f-btn f-btn-primary" onClick={openNew} type="button" data-testid="new-timesheet-btn">
          <Plus size={15} /> New timesheet
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Period</th>
              <th className="px-4 py-2.5 font-medium text-right">Hours</th>
              <th className="px-4 py-2.5 font-medium text-right">Overtime</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sheets.map((s) => (
              <tr key={s.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-medium">
                    {s.periodStart} → {s.periodEnd}
                  </span>
                  <span className="block text-xs text-muted-foreground">{s.lineCount} line(s)</span>
                </td>
                <td className="px-4 py-2.5 text-right font-medium">{s.totalHours.toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {s.overtimeHours > 0 ? <span className="text-amber-600">{s.overtimeHours.toFixed(2)} h</span> : "—"}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded",
                      TIMESHEET_STATUS_BADGE[s.status as keyof typeof TIMESHEET_STATUS_BADGE] ??
                        "bg-muted text-muted-foreground",
                    )}
                  >
                    {TIMESHEET_STATUS_LABELS[s.status as keyof typeof TIMESHEET_STATUS_LABELS] ?? s.status}
                  </span>
                  {s.status === "REJECTED" && s.rejectReason ? (
                    <span className="block text-xs text-destructive mt-0.5 max-w-64 truncate" title={s.rejectReason}>
                      {s.rejectReason}
                    </span>
                  ) : null}
                  {s.approvedByName ? (
                    <span className="block text-xs text-muted-foreground mt-0.5">approved by {s.approvedByName}</span>
                  ) : null}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    {isEditableTimesheet(s.status) && (
                      <>
                        <button
                          className="f-btn f-btn-ghost text-xs"
                          disabled={busy || pending}
                          onClick={() => openEdit(s)}
                          type="button"
                          data-testid={`edit-draft-${s.id}`}
                        >
                          Edit
                        </button>
                        <button
                          className="f-btn f-btn-primary text-xs"
                          disabled={busy || pending || s.totalHours <= 0}
                          onClick={() => submitExisting(s)}
                          type="button"
                          data-testid={`submit-${s.id}`}
                        >
                          <Send size={13} /> Submit
                        </button>
                      </>
                    )}
                    {!isEditableTimesheet(s.status) && (
                      <span className="text-xs text-muted-foreground">
                        {s.status === "SUBMITTED"
                          ? "Awaiting review"
                          : s.status === "LOCKED"
                            ? "Consumed by payroll"
                            : "—"}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {sheets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No timesheets yet — start one with “New timesheet”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editorOpen && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-4" data-testid="timesheet-editor">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">
              {editingId ? "Edit draft" : "New draft"} — {isSelf ? "your hours" : `${employee.name}'s hours`}
            </h2>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="ts-period-start">From</label>
              <input
                id="ts-period-start"
                type="date"
                className={cn(inputCls, "h-8 w-36")}
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
              <label className="text-xs text-muted-foreground" htmlFor="ts-period-end">to</label>
              <input
                id="ts-period-end"
                type="date"
                className={cn(inputCls, "h-8 w-36")}
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={l.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-2">
                <span className="text-xs text-muted-foreground w-6">{i + 1}.</span>
                <input
                  type="date"
                  className={cn(inputCls, "h-8 w-36")}
                  value={l.workDate}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, workDate: e.target.value } : x)))
                  }
                  aria-label={`Line ${i + 1} work day`}
                />
                <input
                  type="number"
                  step="0.25"
                  min="0.25"
                  max="24"
                  className={cn(inputCls, "h-8 w-20 text-right")}
                  value={l.hours}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, hours: e.target.value } : x)))
                  }
                  aria-label={`Line ${i + 1} hours`}
                />
                <span className="text-xs text-muted-foreground">h</span>
                <input
                  className={cn(inputCls, "h-8 w-36")}
                  placeholder="Project (optional)"
                  value={l.projectId}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, projectId: e.target.value } : x)))
                  }
                  aria-label={`Line ${i + 1} project`}
                />
                <input
                  className={cn(inputCls, "h-8 flex-1 min-w-40")}
                  placeholder="What was worked on (optional)"
                  value={l.description}
                  onChange={(e) =>
                    setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))
                  }
                  aria-label={`Line ${i + 1} description`}
                />
                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={l.isBillable}
                    onChange={(e) =>
                      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, isBillable: e.target.checked } : x)))
                    }
                  />
                  Billable
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-amber-700">
                  <input
                    type="checkbox"
                    checked={l.isOvertime}
                    onChange={(e) =>
                      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, isOvertime: e.target.checked } : x)))
                    }
                  />
                  Overtime
                </label>
                <button
                  className="f-btn f-btn-ghost text-xs text-destructive"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button className="f-btn f-btn-ghost text-xs" onClick={addLine} type="button" data-testid="add-line-btn">
              <Plus size={13} /> Add line
            </button>
            <span className="text-sm text-muted-foreground">
              Draft total: <span className="font-medium text-foreground">{draftTotal.toFixed(2)} h</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <button className="f-btn f-btn-ghost" disabled={busy || pending} onClick={() => setEditorOpen(false)} type="button">
                Cancel
              </button>
              <button
                className="f-btn f-btn-ghost"
                disabled={busy || pending || draftTotal <= 0}
                onClick={() => save(false)}
                type="button"
                data-testid="save-draft-btn"
              >
                {busy || pending ? <Loader2 size={14} className="animate-spin" /> : null} Save draft
              </button>
              <button
                className="f-btn f-btn-primary"
                disabled={busy || pending || draftTotal <= 0}
                onClick={() => save(true)}
                type="button"
                data-testid="save-and-submit-btn"
              >
                {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Save &amp; submit
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
