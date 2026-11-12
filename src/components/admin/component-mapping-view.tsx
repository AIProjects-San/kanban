"use client";

// ---------------------------------------------------------------------------
// Task 3.3 — component mapping admin (super admin).
//
// The active SalaryComponents with their statutory tax mapping:
//   taxApplicable      — does money from this component count as taxable income?
//   statutoryCategory  — how the engine classifies the line
//   wageBaseRef        — the statutory wage base it feeds (GROSS | NONE)
// Rows flagged isSystemGenerated are read-only (the seed / engine owns
// them — the server action refuses writes too, this is the UI half).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Lock, Save } from "lucide-react";
import { getComponentTaxMappings, saveComponentTaxMapping } from "@/server-actions/tax-admin";
import type { SalaryComponentT } from "@/lib/types";

const STATUTORY_CATEGORIES: Array<{ value: SalaryComponentT["statutoryCategory"]; label: string }> = [
  { value: "TAXABLE_EARNING", label: "Taxable earning" },
  { value: "NON_TAXABLE", label: "Non-taxable (exempt income)" },
  { value: "PRE_TAX_DEDUCTION", label: "Pre-tax deduction" },
  { value: "POST_TAX_DEDUCTION", label: "Post-tax deduction" },
  { value: "EMPLOYER_CONTRIBUTION", label: "Employer contribution" },
  { value: "STATISTICAL", label: "Statistical (never money)" },
];

const WAGE_BASES: Array<{ value: SalaryComponentT["wageBaseRef"]; label: string }> = [
  { value: "GROSS", label: "GROSS — taxable gross (PAYE / ACC / SL / KiwiSaver base)" },
  { value: "NONE", label: "NONE — excluded from every statutory wage base" },
];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

type Draft = { taxApplicable: boolean; statutoryCategory: SalaryComponentT["statutoryCategory"]; wageBaseRef: SalaryComponentT["wageBaseRef"] };

export function ComponentMappingView({
  initialComponents,
  loadError,
}: {
  initialComponents: SalaryComponentT[];
  loadError: string | null;
}) {
  const [components, setComponents] = useState(initialComponents);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, startTransition] = useTransition();

  const dirtyCount = Object.keys(drafts).length;

  function editRow(c: SalaryComponentT, patch: Partial<Draft>) {
    const base: Draft = drafts[c.id] ?? {
      taxApplicable: c.taxApplicable,
      statutoryCategory: c.statutoryCategory,
      wageBaseRef: c.wageBaseRef,
    };
    setDrafts({ ...drafts, [c.id]: { ...base, ...patch } });
  }

  async function saveRow(c: SalaryComponentT) {
    const draft = drafts[c.id];
    if (!draft) return;
    startTransition(async () => {
      const res = await saveComponentTaxMapping({ id: c.id, ...draft });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved mapping for ${c.code}`);
      const fresh = await getComponentTaxMappings();
      if (fresh.ok) setComponents(fresh.data);
      const next = { ...drafts };
      delete next[c.id];
      setDrafts(next);
    });
  }

  if (loadError) {
    return (
      <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {loadError}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Component mapping</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How each salary component feeds the statutory engine: whether its
          money is taxable, how it is classified, and which wage base it
          contributes to. System-generated rows (the seeded catalog) are
          read-only.
        </p>
        {dirtyCount > 0 && (
          <p className="mt-2 text-xs text-amber-600">
            {dirtyCount} row{dirtyCount === 1 ? "" : "s"} with unsaved changes — save each row to apply.
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Component</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Tax applicable</th>
                <th className="px-4 py-3 font-medium">Statutory category</th>
                <th className="px-4 py-3 font-medium">Wage base</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {components.map((c) => {
                const draft = drafts[c.id];
                const readOnly = c.isSystemGenerated;
                const taxApplicable = draft?.taxApplicable ?? c.taxApplicable;
                const category = draft?.statutoryCategory ?? c.statutoryCategory;
                const wageBase = draft?.wageBaseRef ?? c.wageBaseRef;
                const contradicts =
                  (taxApplicable && category === "NON_TAXABLE") ||
                  (!taxApplicable && category === "TAXABLE_EARNING") ||
                  (taxApplicable && wageBase === "NONE");
                return (
                  <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium">{c.label}</p>
                          <p className="font-mono text-xs text-muted-foreground">{c.code}</p>
                        </div>
                        {readOnly && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                            title="System-generated row — the seed / engine owns its mapping"
                          >
                            <Lock className="h-3 w-3" /> system
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{c.kind}</td>
                    <td className="px-4 py-3">
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={taxApplicable}
                          disabled={readOnly}
                          onChange={(e) => editRow(c, { taxApplicable: e.target.checked })}
                        />
                        <span className={taxApplicable ? "text-foreground" : "text-muted-foreground"}>
                          {taxApplicable ? "Yes" : "No"}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className={`${selectCls} min-w-[190px]`}
                        value={category}
                        disabled={readOnly}
                        onChange={(e) =>
                          editRow(c, { statutoryCategory: e.target.value as SalaryComponentT["statutoryCategory"] })
                        }
                      >
                        {STATUTORY_CATEGORIES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className={`${selectCls} min-w-[260px]`}
                        value={wageBase}
                        disabled={readOnly}
                        onChange={(e) => editRow(c, { wageBaseRef: e.target.value as SalaryComponentT["wageBaseRef"] })}
                      >
                        {WAGE_BASES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {contradicts && (
                        <p className="mb-1 text-[11px] text-destructive">
                          Taxable ↔ category / base contradiction
                        </p>
                      )}
                      {draft ? (
                        <button
                          type="button"
                          onClick={() => saveRow(c)}
                          disabled={pending}
                          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                        >
                          <Save className="h-3 w-3" /> Save
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {readOnly ? "read-only" : "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {components.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No active salary components.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
