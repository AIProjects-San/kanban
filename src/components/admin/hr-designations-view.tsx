"use client";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Designation master (/admin/settings/hr/designations):
// the job-title list, each row optionally linked to a Grade. Renames
// cascade the profile jobTitle mirrors; deletes are guarded (holders).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Briefcase, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { saveDesignation, deleteDesignation } from "@/server-actions/hr-masters";
import type { DesignationT, GradeT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Draft {
  id: string | null;
  name: string;
  code: string;
  gradeId: string;
  isActive: boolean;
}

const BLANK: Draft = { id: null, name: "", code: "", gradeId: "", isActive: true };

export function HrDesignationsView({ designations, grades }: { designations: DesignationT[]; grades: GradeT[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const gradeNameById = new Map(grades.map((g) => [g.id, g.name]));

  const save = () => {
    if (!draft) return;
    setBusy(true);
    startTransition(async () => {
      const res = await saveDesignation({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        code: draft.code || null,
        gradeId: draft.gradeId || null,
        isActive: draft.isActive,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(draft.id ? "Designation updated — holders' job titles follow the rename." : "Designation added.");
      setDraft(null);
      router.refresh();
    });
  };

  const toggleActive = (d: DesignationT) => {
    startTransition(async () => {
      const res = await saveDesignation({ id: d.id, name: d.name, code: d.code, gradeId: d.gradeId, isActive: !d.isActive });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(!d.isActive ? `"${d.name}" reactivated.` : `"${d.name}" deactivated (hidden from pickers).`);
      router.refresh();
    });
  };

  const remove = (d: DesignationT) => {
    startTransition(async () => {
      const res = await deleteDesignation({ id: d.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${d.name}" deleted.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="hr-designations-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Briefcase size={20} /> Designations
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {designations.length} designation{designations.length === 1 ? "" : "s"} — the employee master's job-title axis, each linkable to a grade.
          </p>
        </div>
        <button className="f-btn f-btn-primary" type="button" onClick={() => setDraft({ ...BLANK })}>
          <Plus size={15} /> Add designation
        </button>
      </div>

      {draft && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="designation-form">
          <h2 className="text-sm font-semibold">{draft.id ? `Edit "${draft.name}"` : "Add a designation"}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Name</span>
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Backend Engineer" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Code (optional)</span>
              <input className={inputCls} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="e.g. BE-II" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Grade</span>
              <select className={inputCls} value={draft.gradeId} onChange={(e) => setDraft({ ...draft, gradeId: e.target.value })}>
                <option value="">— no grade link —</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>{g.name} (L{g.level})</option>
                ))}
              </select>
            </label>
          </div>
          {draft.id && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
              Active (inactive designations disappear from every picker)
            </label>
          )}
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending || !draft.name.trim()} onClick={save}>
              {(busy || pending) && <Loader2 size={14} className="animate-spin" />}
              {draft.id ? "Save changes" : "Add designation"}
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Designation</th>
              <th className="px-4 py-2.5 font-medium">Code</th>
              <th className="px-4 py-2.5 font-medium">Grade</th>
              <th className="px-4 py-2.5 font-medium">Employees</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {designations.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-sm text-muted-foreground">
                  No designations yet — add the first one above.
                </td>
              </tr>
            )}
            {designations.map((d) => (
              <tr key={d.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5 font-medium">{d.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{d.code ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{d.gradeId ? gradeNameById.get(d.gradeId) ?? d.gradeName ?? "—" : "—"}</td>
                <td className="px-4 py-2.5">{d.employeeCount}</td>
                <td className="px-4 py-2.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", d.isActive ? "bg-emerald-500/10 text-emerald-700" : "bg-zinc-500/10 text-zinc-500")}>
                    {d.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0" type="button" title="Edit" onClick={() => setDraft({ id: d.id, name: d.name, code: d.code ?? "", gradeId: d.gradeId ?? "", isActive: d.isActive })}>
                      <Pencil size={14} />
                    </button>
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0" type="button" title={d.isActive ? "Deactivate" : "Reactivate"} onClick={() => toggleActive(d)}>
                      <Power size={14} />
                    </button>
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0 text-destructive" type="button" title="Delete" onClick={() => remove(d)}>
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
