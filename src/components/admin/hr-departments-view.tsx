"use client";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Department master's tree editor
// (/admin/settings/hr/departments). The flat list renders as a tree
// (children indented under their parent); renames cascade the profile
// mirror strings server-side; deletes are guarded (employees / children).
// ---------------------------------------------------------------------------

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, CornerDownRight, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { saveDepartment, deleteDepartment } from "@/server-actions/hr-masters";
import type { DepartmentT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Draft {
  id: string | null;
  name: string;
  code: string;
  parentId: string;
  costCenter: string;
  isActive: boolean;
}

const BLANK: Draft = { id: null, name: "", code: "", parentId: "", costCenter: "", isActive: true };

/** Order the flat list as a tree (parents first, children directly under). */
function treeOrder(rows: DepartmentT[]): { row: DepartmentT; depth: number }[] {
  const byParent = new Map<string | null, DepartmentT[]>();
  for (const r of rows) {
    const list = byParent.get(r.parentId) ?? [];
    list.push(r);
    byParent.set(r.parentId, list);
  }
  const out: { row: DepartmentT; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const r of (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ row: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (a parent deleted out from under them) still render at depth 0.
  const seen = new Set(out.map((o) => o.row.id));
  for (const r of rows) if (!seen.has(r.id)) out.push({ row: r, depth: 0 });
  return out;
}

export function HrDepartmentsView({ departments }: { departments: DepartmentT[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const ordered = useMemo(() => treeOrder(departments), [departments]);

  const save = () => {
    if (!draft) return;
    setBusy(true);
    startTransition(async () => {
      const res = await saveDepartment({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        code: draft.code || null,
        parentId: draft.parentId || null,
        costCenter: draft.costCenter || null,
        isActive: draft.isActive,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(draft.id ? "Department updated — profile labels follow the rename." : "Department added.");
      setDraft(null);
      router.refresh();
    });
  };

  const toggleActive = (d: DepartmentT) => {
    startTransition(async () => {
      const res = await saveDepartment({ id: d.id, name: d.name, code: d.code, parentId: d.parentId, costCenter: d.costCenter, isActive: !d.isActive });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(!d.isActive ? `"${d.name}" reactivated.` : `"${d.name}" deactivated (hidden from pickers).`);
      router.refresh();
    });
  };

  const remove = (d: DepartmentT) => {
    startTransition(async () => {
      const res = await deleteDepartment({ id: d.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${d.name}" deleted.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="hr-departments-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Building2 size={20} /> Departments
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {departments.length} department{departments.length === 1 ? "" : "s"} — the employee master's primary grouping axis. Renames follow every profile.
          </p>
        </div>
        <button className="f-btn f-btn-primary" type="button" onClick={() => setDraft({ ...BLANK })}>
          <Plus size={15} /> Add department
        </button>
      </div>

      {draft && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="department-form">
          <h2 className="text-sm font-semibold">{draft.id ? `Edit "${draft.name}"` : "Add a department"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Name</span>
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Engineering" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Code (optional — payroll reporting key)</span>
              <input className={inputCls} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="e.g. ENG" />
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Parent department</span>
              <select className={inputCls} value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}>
                <option value="">— a root department —</option>
                {departments
                  .filter((d) => d.id !== draft.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
              </select>
            </label>
            <label className="text-xs space-y-1 block">
              <span className="text-muted-foreground">Cost center (optional — future GL integration)</span>
              <input className={inputCls} value={draft.costCenter} onChange={(e) => setDraft({ ...draft, costCenter: e.target.value })} placeholder="e.g. CC-1200" />
            </label>
          </div>
          {draft.id && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
              Active (inactive departments disappear from every picker)
            </label>
          )}
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending || !draft.name.trim()} onClick={save}>
              {(busy || pending) && <Loader2 size={14} className="animate-spin" />}
              {draft.id ? "Save changes" : "Add department"}
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Department</th>
              <th className="px-4 py-2.5 font-medium">Code</th>
              <th className="px-4 py-2.5 font-medium">Cost center</th>
              <th className="px-4 py-2.5 font-medium">Employees</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-sm text-muted-foreground">
                  No departments yet — add the first one above.
                </td>
              </tr>
            )}
            {ordered.map(({ row: d, depth }) => (
              <tr key={d.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                    {depth > 0 && <CornerDownRight size={13} className="text-muted-foreground shrink-0" />}
                    <span className="font-medium">{d.name}</span>
                    {d.parentName && depth > 0 && <span className="text-xs text-muted-foreground">· under {d.parentName}</span>}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{d.code ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{d.costCenter ?? "—"}</td>
                <td className="px-4 py-2.5">{d.employeeCount}</td>
                <td className="px-4 py-2.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", d.isActive ? "bg-emerald-500/10 text-emerald-700" : "bg-zinc-500/10 text-zinc-500")}>
                    {d.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button className="f-btn f-btn-ghost h-8 w-8 p-0" type="button" title="Edit" onClick={() => setDraft({ id: d.id, name: d.name, code: d.code ?? "", parentId: d.parentId ?? "", costCenter: d.costCenter ?? "", isActive: d.isActive })}>
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
