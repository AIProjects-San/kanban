"use client";

// ---------------------------------------------------------------------------
// G4 — the roster grid (/admin/shifts/roster): one row per day, the day's
// slots as draggable chips. Native HTML5 drag-and-drop (no library): pick
// a chip up, drop it on another day — moveShift re-dates the slot, and
// the target day's one-slot-per-employee constraint surfaces as the
// friendly toast. Clicking a chip opens that day's roster view (assign /
// swap / unassign / the absence pass live there).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarRange, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { moveShift } from "@/server-actions/shifts";
import type { RosterDayT, ShiftT } from "@/lib/types";
import { SHIFT_ASSIGNMENT_STATUS_LABELS } from "@/lib/hr/shifts";
import { cn } from "@/lib/shared/utils";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftDay(offset: number, from: string): string {
  return new Date(new Date(`${from}T00:00:00.000Z`).getTime() + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function RosterGridView({
  days,
  from,
  to,
  span,
  shifts,
}: {
  days: RosterDayT[];
  from: string;
  to: string;
  span: "week" | "month";
  shifts: ShiftT[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragName, setDragName] = useState("");
  const [dropDay, setDropDay] = useState<string | null>(null);

  const totalSlots = days.reduce((s, d) => s + d.assignments.length, 0);

  const onDrop = (targetDay: string) => {
    const id = dragId;
    setDropDay(null);
    setDragId(null);
    if (!id) return;
    const source = days.flatMap((d) => d.assignments).find((a) => a.id === id);
    if (!source || source.rosterDate === targetDay) return;
    startTransition(async () => {
      const res = await moveShift({ assignmentId: id, toRosterDate: targetDay });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${source.employeeName}'s ${source.shiftName} slot moved to ${targetDay}.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="roster-grid-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <CalendarRange size={20} /> Roster
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {from} → {to} · {totalSlots} slot{totalSlots === 1 ? "" : "s"} across {days.length} day
            {days.length === 1 ? "" : "s"} · {shifts.filter((s) => s.isActive).length} active shift
            {shifts.filter((s) => s.isActive).length === 1 ? "" : "s"} — drag a chip to another day.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/admin/shifts/roster?from=${shiftDay(-7, from)}${span === "month" ? "&span=month" : ""}`}
            className="f-btn f-btn-ghost text-xs"
          >
            <ChevronLeft size={13} /> Back
          </Link>
          <Link href={`/admin/shifts/roster`} className="f-btn f-btn-ghost text-xs">
            This week
          </Link>
          <Link
            href={`/admin/shifts/roster?from=${shiftDay(7, from)}${span === "month" ? "&span=month" : ""}`}
            className="f-btn f-btn-ghost text-xs"
          >
            Next <ChevronRight size={13} />
          </Link>
          <Link
            href={`/admin/shifts/roster?from=${from}${span === "month" ? "" : "&span=month"}`}
            className="f-btn f-btn-ghost text-xs"
          >
            {span === "month" ? "Week view" : "Month view"}
          </Link>
        </div>
      </div>

      <div className="space-y-2" data-testid="roster-grid">
        {days.map((d) => {
          const dow = new Date(`${d.day}T00:00:00.000Z`).getUTCDay();
          const weekend = dow === 0 || dow === 6;
          return (
            <div
              key={d.day}
              className={cn(
                "rounded-lg border border-border bg-card px-3 py-2 flex flex-wrap items-start gap-2 transition-colors",
                weekend && "bg-muted/30",
                dropDay === d.day && "border-primary ring-1 ring-primary",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDropDay(d.day);
              }}
              onDragLeave={() => setDropDay((cur) => (cur === d.day ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(d.day);
              }}
            >
              <Link
                href={`/admin/shifts/roster/${d.day}`}
                className="w-24 shrink-0 pt-1 group"
                title="Open the day's roster"
              >
                <span className="block text-sm font-semibold group-hover:underline">{d.day.slice(8)}</span>
                <span className="block text-xs text-muted-foreground">
                  {DAY_LABELS[dow]} {weekend ? "· wknd" : ""}
                </span>
                <span className="block text-[10px] text-muted-foreground">{d.day.slice(0, 7)}</span>
              </Link>
              <div className="flex flex-1 flex-wrap gap-1.5 min-h-8">
                {d.assignments.map((a) => (
                  <span
                    key={a.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(a.id);
                      setDragName(`${a.employeeName} · ${a.shiftName}`);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropDay(null);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-grab active:cursor-grabbing select-none",
                      dragId === a.id ? "opacity-40" : "border-border bg-muted/40",
                    )}
                    title={`${a.employeeName} · ${a.shiftName} — ${SHIFT_ASSIGNMENT_STATUS_LABELS[a.status as keyof typeof SHIFT_ASSIGNMENT_STATUS_LABELS] ?? a.status}${a.note ? ` · ${a.note}` : ""}`}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        a.status === "SCHEDULED" && "bg-sky-500",
                        a.status === "COMPLETED" && "bg-emerald-500",
                        a.status === "ABSENT" && "bg-destructive",
                        a.status === "SWAPPED" && "bg-violet-500",
                      )}
                    />
                    <span className="font-medium">{a.employeeName}</span>
                    <span className="text-muted-foreground">{a.shiftName}</span>
                  </span>
                ))}
                {d.assignments.length === 0 && (
                  <span className="text-xs text-muted-foreground pt-1.5">
                    {dropDay === d.day && dragName ? `Drop ${dragName} here` : "No slots"}
                  </span>
                )}
                {pending && (
                  <span className="pt-1">
                    <Loader2 size={13} className="animate-spin text-muted-foreground" />
                  </span>
                )}
              </div>
              <Link
                href={`/admin/shifts/roster/${d.day}`}
                className="f-btn f-btn-ghost text-xs shrink-0"
                title="Assign / swap / run absence detection for this day"
              >
                Open
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
