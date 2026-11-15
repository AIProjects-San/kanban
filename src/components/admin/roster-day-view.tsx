"use client";

// ---------------------------------------------------------------------------
// G4 — one roster day (/admin/shifts/roster/[date]): the day's slots with
// the assign form (employee + active shift), per-slot status corrections
// (COMPLETED / back to SCHEDULED), swap-to-another-employee, unassign,
// and the explicit absence-detection pass (§4: assigned but no attendance
// mark = ABSENT).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Moon,
  RotateCcw,
  Trash2,
  UserCheck,
} from "lucide-react";
import {
  assignShift,
  unassignShift,
  setAssignmentStatus,
  swapShift,
  markRosterAbsencesForDay,
} from "@/server-actions/shifts";
import type { ShiftT, ShiftAssignmentT } from "@/lib/types";
import { SHIFT_ASSIGNMENT_STATUS_LABELS } from "@/lib/hr/shifts";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_DOT: Record<string, string> = {
  SCHEDULED: "bg-sky-500",
  COMPLETED: "bg-emerald-500",
  ABSENT: "bg-destructive",
  SWAPPED: "bg-violet-500",
};

export function RosterDayView({
  day,
  assignments,
  shifts,
  employees,
}: {
  day: string;
  assignments: ShiftAssignmentT[];
  shifts: ShiftT[];
  employees: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [swapId, setSwapId] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okToast: string) => {
    setBusy(true);
    startTransition(async () => {
      const res = await fn();
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error ?? "The action failed.");
        return;
      }
      toast.success(okToast);
      setSwapId(null);
      setSwapTarget("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="roster-day-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <CalendarClock size={20} /> Roster · {day}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {assignments.length} slot{assignments.length === 1 ? "" : "s"} ·{" "}
            {assignments.filter((a) => a.status === "SCHEDULED").length} scheduled · one shift per
            employee per day (double-booking is refused at write time).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/shifts/roster?from=${day}`} className="f-btn f-btn-ghost text-xs">
            Back to the grid
          </Link>
          <button
            className="f-btn f-btn-ghost text-xs"
            disabled={busy || pending}
            onClick={() =>
              run(
                () => markRosterAbsencesForDay({ date: day }),
                "Absence detection run — every assigned-but-unmarked slot flipped ABSENT.",
              )
            }
            type="button"
            data-testid="mark-absences-btn"
            title="Every SCHEDULED slot whose employee has no attendance mark for this day flips ABSENT"
          >
            <Moon size={13} /> Mark absences
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm p-4">
        <h2 className="text-sm font-semibold mb-3">Assign a shift</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Employee</span>
            <select
              className={cn(inputCls, "w-52")}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">Pick an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Shift</span>
            <select className={cn(inputCls, "w-52")} value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
              <option value="">Pick a shift…</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.startTime}–{s.endTime}
                  {s.expectedHours != null ? ` (${s.expectedHours.toFixed(1)} h)` : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="f-btn f-btn-primary"
            disabled={busy || pending || !employeeId || !shiftId}
            onClick={() =>
              run(
                () => assignShift({ employeeId, shiftId, rosterDate: day }),
                "Slot assigned.",
              )
            }
            type="button"
            data-testid="assign-btn"
          >
            <UserCheck size={14} /> Assign
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-4 py-2.5 font-medium">Shift</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Note</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5 font-medium">{a.employeeName}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{a.shiftName}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[a.status] ?? "bg-muted")} />
                    {SHIFT_ASSIGNMENT_STATUS_LABELS[a.status as keyof typeof SHIFT_ASSIGNMENT_STATUS_LABELS] ?? a.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-56 truncate" title={a.note}>
                  {a.note || "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {swapId === a.id ? (
                    <span className="inline-flex items-center gap-1.5">
                      <select
                        className={cn(inputCls, "h-8 w-44")}
                        value={swapTarget}
                        onChange={(e) => setSwapTarget(e.target.value)}
                      >
                        <option value="">Swap with…</option>
                        {employees
                          .filter((e) => e.id !== a.employeeId)
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                            </option>
                          ))}
                      </select>
                      <button
                        className="f-btn f-btn-ghost text-xs"
                        disabled={busy || pending}
                        onClick={() => {
                          setSwapId(null);
                          setSwapTarget("");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="f-btn f-btn-primary text-xs"
                        disabled={busy || pending || !swapTarget}
                        onClick={() =>
                          run(
                            () => swapShift({ assignmentId: a.id, toEmployeeId: swapTarget }),
                            "Slot swapped.",
                          )
                        }
                        type="button"
                        data-testid={`swap-confirm-${a.id}`}
                      >
                        Confirm swap
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {a.status === "SCHEDULED" && (
                        <>
                          <button
                            className="f-btn f-btn-ghost text-xs"
                            disabled={busy || pending}
                            onClick={() =>
                              run(
                                () => setAssignmentStatus({ assignmentId: a.id, status: "COMPLETED" }),
                                "Slot marked completed.",
                              )
                            }
                            type="button"
                            title="Attendance confirmed the slot was worked"
                          >
                            <CheckCircle2 size={13} /> Complete
                          </button>
                          <button
                            className="f-btn f-btn-ghost text-xs"
                            disabled={busy || pending}
                            onClick={() => setSwapId(a.id)}
                            type="button"
                            data-testid={`swap-btn-${a.id}`}
                          >
                            Swap
                          </button>
                        </>
                      )}
                      {a.status !== "SCHEDULED" && (
                        <button
                          className="f-btn f-btn-ghost text-xs"
                          disabled={busy || pending}
                          onClick={() =>
                            run(
                              () => setAssignmentStatus({ assignmentId: a.id, status: "SCHEDULED" }),
                              "Slot reset to scheduled.",
                            )
                          }
                          type="button"
                          title="Reset the status correction"
                        >
                          <RotateCcw size={13} /> Reset
                        </button>
                      )}
                      <button
                        className="f-btn f-btn-ghost text-xs text-destructive"
                        disabled={busy || pending}
                        onClick={() => run(() => unassignShift({ assignmentId: a.id }), "Slot removed.")}
                        type="button"
                        data-testid={`unassign-btn-${a.id}`}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No slots on this day — assign the first one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
