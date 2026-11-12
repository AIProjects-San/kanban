"use client";

// ---------------------------------------------------------------------------
// Task 3.2 — statutory rule admin, grouped by category.
//
// Editing a rule never rewrites history: the form creates a NEW VERSION —
// a cloned rate set with only that category changed, effective from the
// chosen date. The source set's window closes at that date, and locked
// payslips keep their snapshots (that is also why a set referenced by a
// locked run can never be deleted — archive-only, enforced server-side).
// ---------------------------------------------------------------------------

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Archive, GitBranchPlus, Trash2, X } from "lucide-react";
import {
  archiveTaxYear,
  createRuleVersion,
  deleteTaxYear,
  getTaxYears,
} from "@/server-actions/tax-admin";
import type { TaxSlabRowT, TaxYearAdminT } from "@/lib/types";

type Category =
  | "PAYE"
  | "SECONDARY"
  | "ESCT"
  | "ACC"
  | "IETC"
  | "KIWISAVER"
  | "STUDENT_LOAN";

const CATEGORIES: Array<{ key: Category; label: string; blurb: string }> = [
  { key: "PAYE", label: "PAYE income-tax slabs", blurb: "Marginal annual brackets for the M / ME codes (income tax only — the levy is a separate line)." },
  { key: "SECONDARY", label: "Secondary flat rates", blurb: "SB / S / SH / ST / SA / ND flat rates on every dollar, before ACC levies (or combined, with the ACC-incl. flag)." },
  { key: "ACC", label: "ACC earners' levy", blurb: "Rate, liable-earnings cap and the published maximum levy." },
  { key: "IETC", label: "IETC (ME code)", blurb: "The independent earner tax credit with its abatement window." },
  { key: "KIWISAVER", label: "KiwiSaver", blurb: "Default employee rate, allowed elections and the compulsory employer rate." },
  { key: "ESCT", label: "ESCT tiers", blurb: "Employer superannuation contribution tax, banded on salary + employer contributions." },
  { key: "STUDENT_LOAN", label: "Student loan", blurb: "Repayment rate over the annual threshold." },
];

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const money = (n: number | null) =>
  n == null ? "above" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The latest set whose window covers today (the "current rules"). */
function currentSet(taxYears: TaxYearAdminT[]): TaxYearAdminT | null {
  const today = todayStr();
  return (
    taxYears.find(
      (y) => y.effectiveFrom <= today && (y.effectiveTo == null || y.effectiveTo > today),
    ) ?? taxYears[0] ?? null
  );
}

export function TaxRulesView({
  initialTaxYears,
  loadError,
}: {
  initialTaxYears: TaxYearAdminT[];
  loadError: string | null;
}) {
  const [taxYears, setTaxYears] = useState(initialTaxYears);
  const current = useMemo(() => currentSet(taxYears), [taxYears]);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [pending, startTransition] = useTransition();

  const [effectiveFrom, setEffectiveFrom] = useState(todayStr());
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [slabs, setSlabs] = useState<TaxSlabRowT[]>([]);
  const [acc, setAcc] = useState<TaxYearAdminT["params"]["acc"]>(null);
  const [ietc, setIetc] = useState<TaxYearAdminT["params"]["ietc"]>(null);
  const [kiwiSaver, setKiwiSaver] = useState<TaxYearAdminT["params"]["kiwiSaver"]>(null);
  const [studentLoan, setStudentLoan] = useState<TaxYearAdminT["params"]["studentLoan"]>(null);

  function openEditor(cat: Category) {
    if (!current) return;
    setEditingCategory(cat);
    const meta = CATEGORIES.find((c) => c.key === cat)!;
    setEffectiveFrom(todayStr());
    setLabel(`${meta.label} change — effective ${todayStr()}`);
    setNotes("");
    setSlabs(JSON.parse(JSON.stringify(current.slabs)) as TaxSlabRowT[]);
    setAcc(current.params.acc ? { ...current.params.acc } : null);
    setIetc(current.params.ietc ? { ...current.params.ietc } : null);
    setKiwiSaver(current.params.kiwiSaver ? { ...current.params.kiwiSaver } : null);
    setStudentLoan(current.params.studentLoan ? { ...current.params.studentLoan } : null);
  }

  async function refresh() {
    const res = await getTaxYears();
    if (res.ok) setTaxYears(res.data);
  }

  function submitVersion() {
    if (!current || !editingCategory) return;
    startTransition(async () => {
      const res = await createRuleVersion({
        sourceSetId: current.id,
        category: editingCategory,
        effectiveFrom,
        label,
        notes,
        values: {
          slabs: editingCategory === "PAYE" || editingCategory === "SECONDARY" || editingCategory === "ESCT"
            ? slabs
                .filter((s) => s.group === editingCategory)
                .map((s) => ({
                  group: s.group, code: s.code, label: s.label, lower: s.lower,
                  upper: s.upper, rate: s.rate, accInclusive: s.accInclusive, order: s.order,
                }))
            : undefined,
          acc: editingCategory === "ACC" ? acc : undefined,
          ietc: editingCategory === "IETC" ? ietc : undefined,
          kiwiSaver: editingCategory === "KIWISAVER" ? kiwiSaver : undefined,
          studentLoan: editingCategory === "STUDENT_LOAN" ? studentLoan : undefined,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Version "${res.data.label}" created`);
      setEditingCategory(null);
      await refresh();
    });
  }

  function archive(year: TaxYearAdminT) {
    startTransition(async () => {
      const res = await archiveTaxYear({ setId: year.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Archived "${year.label}"`);
      await refresh();
    });
  }

  function remove(year: TaxYearAdminT) {
    startTransition(async () => {
      const res = await deleteTaxYear({ setId: year.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Deleted "${year.label}"`);
      await refresh();
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
        <h1 className="text-2xl font-semibold tracking-tight">Statutory rules</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Grouped by category. Editing a category creates a <strong>new version</strong>{" "}
          effective from the date you pick — the current set keeps serving pay
          periods before it, and locked payslips keep their snapshots forever.
          Sets referenced by locked runs can be archived but never deleted.
          {current && (
            <>
              {" "}Current rules: <span className="font-medium text-foreground">{current.label}</span>.
            </>
          )}
        </p>
      </div>

      {/* Category cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {CATEGORIES.map((cat) => {
          const editing = editingCategory === cat.key;
          return (
            <section
              key={cat.key}
              className={`rounded-xl border bg-card shadow-sm ${editing ? "border-primary/50 md:col-span-2" : "border-border"}`}
            >
              <header className="flex items-start gap-3 border-b border-border px-5 py-4">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">{cat.label}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{cat.blurb}</p>
                </div>
                <div className="ml-auto shrink-0">
                  {editing ? (
                    <button
                      type="button"
                      onClick={() => setEditingCategory(null)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                    >
                      <X className="h-3 w-3" /> Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={current == null}
                      onClick={() => openEditor(cat.key)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      <GitBranchPlus className="h-3 w-3" /> New version
                    </button>
                  )}
                </div>
              </header>

              <div className="px-5 py-4">
                {/* Read-only current values */}
                {!editing && current && <CategorySummary category={cat.key} set={current} />}

                {/* The new-version form */}
                {editing && (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium">Effective from</label>
                        <input
                          type="date"
                          className={inputCls}
                          value={effectiveFrom}
                          onChange={(e) => setEffectiveFrom(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium">New version label</label>
                        <input
                          className={inputCls}
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                        />
                      </div>
                    </div>

                    {(cat.key === "PAYE" || cat.key === "SECONDARY" || cat.key === "ESCT") && (
                      <SlabEditor
                        group={cat.key}
                        slabs={slabs}
                        onChange={setSlabs}
                      />
                    )}
                    {cat.key === "ACC" && acc && (
                      <div className="grid grid-cols-3 gap-3">
                        <Field label="Rate %">
                          <input type="number" className={inputCls} value={acc.rate} onChange={(e) => setAcc({ ...acc, rate: Number(e.target.value) })} />
                        </Field>
                        <Field label="Max earnings $">
                          <input type="number" className={inputCls} value={acc.maxEarnings} onChange={(e) => setAcc({ ...acc, maxEarnings: Number(e.target.value) })} />
                        </Field>
                        <Field label="Max levy $">
                          <input type="number" className={inputCls} value={acc.maxLevy} onChange={(e) => setAcc({ ...acc, maxLevy: Number(e.target.value) })} />
                        </Field>
                      </div>
                    )}
                    {cat.key === "IETC" && ietc && (
                      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                        <Field label="Amount $"><input type="number" className={inputCls} value={ietc.annualAmount} onChange={(e) => setIetc({ ...ietc, annualAmount: Number(e.target.value) })} /></Field>
                        <Field label="From $"><input type="number" className={inputCls} value={ietc.lowerBound} onChange={(e) => setIetc({ ...ietc, lowerBound: Number(e.target.value) })} /></Field>
                        <Field label="Abates from $"><input type="number" className={inputCls} value={ietc.abateFrom} onChange={(e) => setIetc({ ...ietc, abateFrom: Number(e.target.value) })} /></Field>
                        <Field label="Gone at $"><input type="number" className={inputCls} value={ietc.upperBound} onChange={(e) => setIetc({ ...ietc, upperBound: Number(e.target.value) })} /></Field>
                        <Field label="Abate %"><input type="number" className={inputCls} value={ietc.abateRate} onChange={(e) => setIetc({ ...ietc, abateRate: Number(e.target.value) })} /></Field>
                      </div>
                    )}
                    {cat.key === "KIWISAVER" && kiwiSaver && (
                      <div className="grid grid-cols-3 gap-3">
                        <Field label="Default employee %"><input type="number" className={inputCls} value={kiwiSaver.defaultEmployeeRate} onChange={(e) => setKiwiSaver({ ...kiwiSaver, defaultEmployeeRate: Number(e.target.value) })} /></Field>
                        <Field label="Employer %"><input type="number" className={inputCls} value={kiwiSaver.employerRate} onChange={(e) => setKiwiSaver({ ...kiwiSaver, employerRate: Number(e.target.value) })} /></Field>
                        <Field label="Allowed rates (comma-separated %)">
                          <input
                            className={inputCls}
                            value={kiwiSaver.allowedEmployeeRates.join(", ")}
                            onChange={(e) =>
                              setKiwiSaver({
                                ...kiwiSaver,
                                allowedEmployeeRates: e.target.value
                                  .split(",")
                                  .map((s) => Number(s.trim()))
                                  .filter((n) => Number.isFinite(n) && n > 0),
                              })
                            }
                          />
                        </Field>
                      </div>
                    )}
                    {cat.key === "STUDENT_LOAN" && studentLoan && (
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Rate %"><input type="number" className={inputCls} value={studentLoan.rate} onChange={(e) => setStudentLoan({ ...studentLoan, rate: Number(e.target.value) })} /></Field>
                        <Field label="Annual threshold $"><input type="number" className={inputCls} value={studentLoan.annualThreshold} onChange={(e) => setStudentLoan({ ...studentLoan, annualThreshold: Number(e.target.value) })} /></Field>
                      </div>
                    )}

                    <Field label="Notes (optional)">
                      <input
                        className={inputCls}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="IRD reference / gazette notice behind this change"
                      />
                    </Field>

                    <button
                      type="button"
                      onClick={submitVersion}
                      disabled={pending}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    >
                      <GitBranchPlus className="h-4 w-4" />
                      Create version effective {effectiveFrom}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      Clones every other category from &ldquo;{current?.label}&rdquo; unchanged;
                      that set&apos;s window closes on {effectiveFrom}.
                    </p>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Version history */}
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <header className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Version history</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every rate set, newest first. Locked runs pin their set — those rows
            are archive-only.
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Tax year</th>
                <th className="px-5 py-2.5 font-medium">Window</th>
                <th className="px-5 py-2.5 font-medium">Locked runs</th>
                <th className="px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {taxYears.map((y) => (
                <tr key={y.id} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{y.label}</span>
                      {y.isCurrent && (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">current</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 tabular-nums text-muted-foreground">
                    {y.effectiveFrom} → {y.effectiveTo ?? "open"}
                  </td>
                  <td className="px-5 py-3">
                    {y.lockedRunCount > 0 ? (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                        {y.lockedRunCount}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">none</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        title="Retire from the resolution chain (effectiveTo = today)"
                        onClick={() => archive(y)}
                        disabled={pending}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-60"
                      >
                        <Archive className="h-3 w-3" /> Archive
                      </button>
                      <button
                        type="button"
                        title={
                          y.lockedRunCount > 0
                            ? "Referenced by locked payslips — archive-only"
                            : "Delete this unreferenced set"
                        }
                        onClick={() => remove(y)}
                        disabled={pending || y.lockedRunCount > 0}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                        {y.lockedRunCount > 0 ? "Archive-only" : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/** Read-only current values for one category. */
function CategorySummary({ category, set }: { category: Category; set: TaxYearAdminT }) {
  switch (category) {
    case "PAYE":
      return (
        <ul className="space-y-1 text-sm">
          {set.slabs.filter((s) => s.group === "PAYE").map((s) => (
            <li key={s.id} className="flex justify-between tabular-nums">
              <span className="text-muted-foreground">{money(s.lower)} – {money(s.upper)}</span>
              <span className="font-medium">{s.rate}%</span>
            </li>
          ))}
        </ul>
      );
    case "SECONDARY":
      return (
        <ul className="space-y-1 text-sm">
          {set.slabs.filter((s) => s.group === "SECONDARY").map((s) => (
            <li key={s.id} className="flex justify-between tabular-nums">
              <span className="font-mono text-xs">{s.code}</span>
              <span className="font-medium">
                {s.rate}%{s.accInclusive ? " (ACC incl.)" : ""}
              </span>
            </li>
          ))}
        </ul>
      );
    case "ESCT":
      return (
        <ul className="space-y-1 text-sm">
          {set.slabs.filter((s) => s.group === "ESCT").map((s) => (
            <li key={s.id} className="flex justify-between tabular-nums">
              <span className="text-muted-foreground">{money(s.lower)} – {money(s.upper)}</span>
              <span className="font-medium">{s.rate}%</span>
            </li>
          ))}
        </ul>
      );
    case "ACC": {
      const a = set.params.acc;
      return (
        <ul className="space-y-1 text-sm tabular-nums">
          <li className="flex justify-between"><span className="text-muted-foreground">Levy rate</span><span className="font-medium">{a?.rate}%</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Liable-earnings cap</span><span className="font-medium">{a ? money(a.maxEarnings) : "—"}</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Maximum levy</span><span className="font-medium">{a ? money(a.maxLevy) : "—"}</span></li>
        </ul>
      );
    }
    case "IETC": {
      const i = set.params.ietc;
      return (
        <ul className="space-y-1 text-sm tabular-nums">
          <li className="flex justify-between"><span className="text-muted-foreground">Annual credit</span><span className="font-medium">{i ? money(i.annualAmount) : "—"}</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Window</span><span className="font-medium">{i ? `${money(i.lowerBound)} – ${money(i.upperBound)}` : "—"}</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Abatement</span><span className="font-medium">{i ? `${i.abateRate}% above ${money(i.abateFrom)}` : "—"}</span></li>
        </ul>
      );
    }
    case "KIWISAVER": {
      const k = set.params.kiwiSaver;
      return (
        <ul className="space-y-1 text-sm tabular-nums">
          <li className="flex justify-between"><span className="text-muted-foreground">Default employee</span><span className="font-medium">{k?.defaultEmployeeRate}%</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Employer</span><span className="font-medium">{k?.employerRate}%</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Allowed elections</span><span className="font-medium">{k?.allowedEmployeeRates.map((r) => `${r}%`).join(" · ")}</span></li>
        </ul>
      );
    }
    case "STUDENT_LOAN": {
      const s = set.params.studentLoan;
      return (
        <ul className="space-y-1 text-sm tabular-nums">
          <li className="flex justify-between"><span className="text-muted-foreground">Repayment rate</span><span className="font-medium">{s?.rate}%</span></li>
          <li className="flex justify-between"><span className="text-muted-foreground">Annual threshold</span><span className="font-medium">{s ? money(s.annualThreshold) : "—"}</span></li>
        </ul>
      );
    }
  }
}

/** Editable rows for one slab family inside the version form. */
function SlabEditor({
  group,
  slabs,
  onChange,
}: {
  group: "PAYE" | "SECONDARY" | "ESCT";
  slabs: TaxSlabRowT[];
  onChange: (s: TaxSlabRowT[]) => void;
}) {
  const rows = slabs.filter((s) => s.group === group);
  const banded = group !== "SECONDARY";
  const update = (idx: number, patch: Partial<TaxSlabRowT>) => {
    const next = [...slabs];
    const realIdx = slabs.indexOf(rows[idx]);
    next[realIdx] = { ...rows[idx], ...patch };
    onChange(next);
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {group === "SECONDARY" && <th className="px-3 py-2 font-medium">Code</th>}
            {banded && <th className="px-3 py-2 font-medium">Lower $</th>}
            {banded && <th className="px-3 py-2 font-medium">Upper $</th>}
            <th className="px-3 py-2 font-medium">Rate %</th>
            {group === "SECONDARY" && <th className="px-3 py-2 font-medium">ACC incl.</th>}
            {banded && <th className="px-3 py-2 font-medium">Order</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id} className="border-b border-border/60 last:border-0">
              {group === "SECONDARY" && (
                <td className="px-3 py-2">
                  <input
                    className={`${inputCls} w-20 font-mono uppercase`}
                    value={row.code}
                    onChange={(e) => update(idx, { code: e.target.value.toUpperCase() })}
                  />
                </td>
              )}
              {banded && (
                <td className="px-3 py-2">
                  <input type="number" className={`${inputCls} w-28`} value={row.lower ?? ""} onChange={(e) => update(idx, { lower: e.target.value === "" ? null : Number(e.target.value) })} />
                </td>
              )}
              {banded && (
                <td className="px-3 py-2">
                  <input type="number" className={`${inputCls} w-28`} placeholder="open" value={row.upper ?? ""} onChange={(e) => update(idx, { upper: e.target.value === "" ? null : Number(e.target.value) })} />
                </td>
              )}
              <td className="px-3 py-2">
                <input type="number" className={`${inputCls} w-24`} value={row.rate} onChange={(e) => update(idx, { rate: Number(e.target.value) })} />
              </td>
              {group === "SECONDARY" && (
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={row.accInclusive}
                    onChange={(e) => update(idx, { accInclusive: e.target.checked })}
                  />
                </td>
              )}
              {banded && (
                <td className="px-3 py-2">
                  <input type="number" className={`${inputCls} w-20`} value={row.order} onChange={(e) => update(idx, { order: Number(e.target.value) })} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
