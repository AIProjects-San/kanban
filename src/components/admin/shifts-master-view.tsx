"use client";

// ---------------------------------------------------------------------------
// G4 — the shift master view (/admin/shifts): the catalog with create /
// edit (name, clock times, unpaid break, active flag). Overnight is
// derived server-side from the times and shown as a badge; expected
// hours come from the kernel's clock math.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Moon, Pencil, Plus } from "lucide-react";
import { createShift, updateShift } from "@/server-actions/shifts";
import type { ShiftT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Draft {
  id: string | null;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: string;
  isActive: boolean;
}

const BLANK: Draft = { id: null, name: "", startTime: "09:00", endTime: "17:00", breakMinutes: "30", isActive: true };

export function ShiftsMasterView({ shifts }: { shifts: ShiftT[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = () => {
    if (!draft) return;
    setBusy(true);
    const payload = {
      name: draft.name,
      startTime: draft.startTime,
      endTime: draft.endTime,
      breakMinutes: Number.parseInt(draft.breakMinutes || "0", 10) || 0,
      isActive: draft.isActive,
    };
    startTransition(async () => {
      const res = draft.id
        ? await updateShift({ shiftId: draft.id, ...payload })
        : await createShift(payload);
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(draft.id ? "Shift updated." : "Shift created.");
      setDraft(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="shifts-master-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Moon size={20} /> Shifts
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {shifts.length} definition{shifts.length === 1 ? "" : "s"} — shifts define EXPECTED hours;
            the roster assigns them, attendance and timesheets carry the actuals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="f-btn f-btn-primary" onClick={() => setDraft({ ...BLANK })} type="button" data-testid="new-shift-btn">
            <Plus size={15} /> New shift
          </button>
        </div>
      </div>

      {draft && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="shift-editor">
          <h2 className="text-sm font-semibold">{draft.id ? "Edit shift" : "New shift"}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <input
                className={cn(inputCls, "w-48")}
                placeholder="e.g. Early birds"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Start (HH:mm)</span>
              <input
                className={cn(inputCls, "w-24")}
                placeholder="09:00"
                value={draft.startTime}
                onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">End (HH:mm)</span>
              <input
                className={cn(inputCls, "w-24")}
                placeholder="17:00"
                value={draft.endTime}
                onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Unpaid break (min)</span>
              <input
                className={cn(inputCls, "w-24 text-right")}
                type="number"
                min="0"
                max="240"
                value={draft.breakMinutes}
                onChange={(e) => setDraft({ ...draft, breakMinutes: e.target.value })}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm pb-2">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              />
              Active (rosterable)
            </label>
            <span className="inline-flex items-center gap-2 pb-1 ml-auto">
              <button className="f-btn f-btn-ghost" disabled={busy || pending} onClick={() => setDraft(null)} type="button">
                Cancel
              </button>
              <button
                className="f-btn f-btn-primary"
                disabled={busy || pending || !draft.name.trim()}
                onClick={save}
                type="button"
                data-testid="save-shift-btn"
              >
                {busy || pending ? <Loader2 size={14} className="animate-spin" /> : null} Save shift
              </button>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            An end time earlier than the start crosses midnight (an overnight shift) — derived
            automatically, and its roster slot links both calendar days it spans.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Times</th>
              <th className="px-4 py-2.5 font-medium text-right">Break</th>
              <th className="px-4 py-2.5 font-medium text-right">Expected</th>
              <th className="px-4 py-2.5 font-medium text-right">Slots</th>
              <th className="px-4 py-2.5 font-medium">State</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.id} className={cn("border-b border-border/60 last:border-0", !s.isActive && "opacity-60")}>
                <td className="px-4 py-2.5 font-medium">{s.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {s.startTime} – {s.endTime}
                  {s.isOvernight && (
                    <span className="ml-2 text-[0.625rem] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-700">
                      overnight
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{s.breakMinutes} min</td>
                <td className="px-4 py-2.5 text-right font-medium">
                  {s.expectedHours != null ? `${s.expectedHours.toFixed(2)} h` : "—"}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{s.assignmentCount}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded",
                      s.isActive ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {s.isActive ? "Active" : "Retired"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    className="f-btn f-btn-ghost text-xs"
                    disabled={busy || pending}
                    onClick={() =>
                      setDraft({
                        id: s.id,
                        name: s.name,
                        startTime: s.startTime,
                        endTime: s.endTime,
                        breakMinutes: String(s.breakMinutes),
                        isActive: s.isActive,
                      })
                    }
                    type="button"
                    data-testid={`edit-shift-${s.id}`}
                  >
                    <Pencil size={13} /> Edit
                  </button>
                </td>
              </tr>
            ))}
            {shifts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No shifts yet — create the workspace’s first shift definition.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
