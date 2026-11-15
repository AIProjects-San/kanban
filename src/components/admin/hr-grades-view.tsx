"use client";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Grade ladder (/admin/settings/hr/grades): ordered
// levels with an optional salary band (min ≤ max, validated on save).
// Renames cascade the profile grade mirrors; deletes are guarded
// (holders + linked designations).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Medal, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { saveGrade, deleteGrade } from "@/server-actions/hr-masters";
import type { GradeT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Draft {
  id: string | null;
  name: string;
  level: string;
  minBase: string;
  maxBase: string;
  isActive: boolean;
}

const BLANK: Draft = { id: null, name: "", level: "1", minBase: "", maxBase: "", isActive: true };

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
}

export function HrGradesView({ grades }: { grades: GradeT[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = () => {
    if (!draft) return;
    setBusy(true);
    startTransition(async () => {
      const res = await saveGrade({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        level: Math.max(1, Number.parseInt(draft.level || "1", 10) || 1),
        minBase: draft.minBase.trim() === "" ? null : Number(draft.minBase),
        maxBase: draft.maxBase.trim() === "" ? null : Number(draft.maxBase),
        isActive: draft.isActive,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(draft.id ? "Grade updated — holders' grade labels follow the rename." : "Grade added.");
      setDraft(null);
      router.refresh();
    });
  };

  const toggleActive = (g: GradeT) => {
    startTransition(async () => {
      const res = await saveGrade({ id: g.id, name: g.name, level: g.level, minBase: g.minBase, maxBase: g.maxBase, isActive: !g.isActive });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(!g.isActive ? `"${g.name}" reactivated.` : `"${g.name}" deactivated (hidden from pickers).`);
      router.refresh();
    });
  };

  const remove = (g: GradeT) => {
    startTransition(async () => {
      const res = await deleteGrade({ id: g.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${g.name}" deleted.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="hr-grades-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Medal size={20} /> Grades
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {grades.length} grade{grades.length === 1 ? "" : "s"} — the ladder, ordered by level, each with an optional salary band.
          </p>
        </div>
        <button className="f-btn f-btn-primary" type="button" onClick={() => setDraft({ ...BLANK, level: String((grades.at(-1)?.level ?? 0) + 1) })}>
          <Plus size={15} /> Add grade
        </button>
      </div>

      {draft && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="grade-form">
          <h2 className="text-sm font-semibold">{draft.id ? `Edit "${draft.name}"` : "Add a grade"}</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Name</span>
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. L4" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Level (ordering)</span>
              <input className={inputCls} inputMode="numeric" value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })} placeholder="e.g. 4" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Band minimum (annual, optional)</span>
              <input className={inputCls} inputMode="decimal" value={draft.minBase} onChange={(e) => setDraft({ ...draft, minBase: e.target.value })} placeholder="e.g. 60000" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Band maximum (annual, optional)</span>
              <input className={inputCls} inputMode="decimal" value={draft.maxBase} onChange={(e) => setDraft({ ...draft, maxBase: e.target.value })} placeholder="e.g. 90000" />
            </label>
          </div>
          {draft.id && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
              Active (inactive grades disappear from every picker)
            </label>
          )}
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending || !draft.name.trim()} onClick={save}>
              {(busy || pending) && <Loader2 size={14} className="animate-spin" />}
              {draft.id ? "Save changes" : "Add grade"}
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Level</th>
              <th className="px-4 py-2.5 font-medium">Grade</th>
              <th className="px-4 py-2.5 font-medium">Salary band (annual)</th>
              <th className="px-4 py-2.5 font-medium">Designations</th>
              <th className="px-4 py-2.5 font-medium">Employees</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-sm text-muted-foreground">
                  No grades yet — add the first rung above.
                </td>
              </tr>
            )}
            {grades.map((g) => (
              <tr key={g.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5 text-muted-foreground">{g.level}</td>
                <td className="px-4 py-2.5 font-medium">{g.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {g.minBase != null || g.maxBase != null ? `${fmtMoney(g.minBase)} – ${fmtMoney(g.maxBase)}` : "—"}
                </td>
                <td className="px-4 py-2.5">{g.designationCount}</td>
                <td className="px-4 py-2.5">{g.employeeCount}</td>
                <td className="px-4 py-2.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", g.isActive ? "bg-emerald-500/10 text-emerald-700" : "bg-zinc-500/10 text-zinc-500")}>
                    {g.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0" type="button" title="Edit" onClick={() => setDraft({ id: g.id, name: g.name, level: String(g.level), minBase: g.minBase != null ? String(g.minBase) : "", maxBase: g.maxBase != null ? String(g.maxBase) : "", isActive: g.isActive })}>
                      <Pencil size={14} />
                    </button>
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0" type="button" title={g.isActive ? "Deactivate" : "Reactivate"} onClick={() => toggleActive(g)}>
                      <Power size={14} />
                    </button>
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0 text-destructive" type="button" title="Delete" onClick={() => remove(g)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
