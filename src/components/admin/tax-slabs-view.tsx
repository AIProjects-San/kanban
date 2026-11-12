"use client";

// ---------------------------------------------------------------------------
// Task 3.1 — the tax year + slab editor (super admin).
//
// One card per TaxYear (StatutoryRateSet): the unified editable slab table
// (group · code · lower · upper · rate % · accInclusive · order) covering
// the PAYE tiers, secondary flat rates and ESCT tiers, plus the
// single-value rule families (ACC levy, IETC, KiwiSaver, student loan)
// beneath it. A year referenced by LOCKED payroll runs is read-only — its
// edits must go through the versioned rule admin (Task 3.2). The Simulate
// panel runs the SAVED set through the Phase 1 engine (annualised gross →
// tax + ACC split).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Plus, RotateCcw, Save, Trash2, Wand2 } from "lucide-react";
import { getTaxYears, saveTaxYearSlabs, simulateTax } from "@/server-actions/tax-admin";
import type { TaxSlabRowT, TaxSimulateResultT, TaxYearAdminT } from "@/lib/types";

const FREQUENCIES = [
  { key: "ANNUAL", label: "Annualised gross (annual)" },
  { key: "MONTHLY", label: "Monthly" },
  { key: "FORTNIGHTLY", label: "Fortnightly" },
  { key: "WEEKLY", label: "Weekly" },
  { key: "BIMONTHLY", label: "Twice a month" },
  { key: "QUARTERLY", label: "Quarterly" },
] as const;

const SIM_CODES = ["M", "ME", "SB", "S", "SH", "ST", "SA", "ND", "STC"] as const;

const GROUP_LABELS: Record<TaxSlabRowT["group"], string> = {
  PAYE: "PAYE (M / ME)",
  SECONDARY: "Secondary flat rates",
  ESCT: "ESCT tiers",
};

const money = (n: number | null) =>
  n == null ? "above" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

function NumCell({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className={inputCls}
      value={value ?? ""}
      placeholder={placeholder ?? "—"}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

export function TaxSlabsView({
  initialTaxYears,
  loadError,
}: {
  initialTaxYears: TaxYearAdminT[];
  loadError: string | null;
}) {
  const [taxYears, setTaxYears] = useState(initialTaxYears);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaxYearAdminT | null>(null);
  const [pending, startTransition] = useTransition();

  function beginEdit(year: TaxYearAdminT) {
    setEditingId(year.id);
    setDraft(JSON.parse(JSON.stringify(year)) as TaxYearAdminT);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function refresh() {
    const res = await getTaxYears();
    if (res.ok) setTaxYears(res.data);
  }

  function save() {
    if (!draft) return;
    startTransition(async () => {
      const res = await saveTaxYearSlabs({
        setId: draft.id,
        slabs: draft.slabs.map((s) => ({
          group: s.group,
          code: s.code,
          label: s.label,
          lower: s.lower,
          upper: s.upper,
          rate: s.rate,
          accInclusive: s.accInclusive,
          order: s.order,
        })),
        acc: draft.params.acc,
        ietc: draft.params.ietc,
        kiwiSaver: draft.params.kiwiSaver,
        studentLoan: draft.params.studentLoan,
        notes: draft.notes,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved "${draft.label}"`);
      cancelEdit();
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
        <h1 className="text-2xl font-semibold tracking-tight">Tax years &amp; slabs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The effective-dated statutory rate sets — PAYE slabs, secondary flat
          rates, ESCT tiers and the single-value rules (ACC levy, IETC,
          KiwiSaver, student loan). A tax year referenced by locked payroll
          runs is read-only: edit it through a new version on the{" "}
          <a href="/settings/tax/rules" className="text-primary hover:underline">
            statutory rules
          </a>{" "}
          page.
        </p>
      </div>

      {taxYears.map((year) => {
        const editing = editingId === year.id && draft != null;
        const model = editing ? draft! : year;
        const locked = year.lockedRunCount > 0;
        return (
          <section key={year.id} className="rounded-xl border border-border bg-card shadow-sm">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold">{year.label}</h2>
                  {year.isCurrent && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                      current
                    </span>
                  )}
                  {locked && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                      {year.lockedRunCount} locked run{year.lockedRunCount === 1 ? "" : "s"} reference this
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Effective {year.effectiveFrom} → {year.effectiveTo ?? "open"} · created {year.createdAt.slice(0, 10)}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Cancel
                    </button>
                    <button
                      type="button"
                      onClick={save}
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    >
                      <Save className="h-3.5 w-3.5" /> Save tax year
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => (locked ? toast.error(`"${year.label}" is referenced by ${year.lockedRunCount} locked run${year.lockedRunCount === 1 ? "" : "s"} — create a new version on the Statutory rules page instead.`) : beginEdit(year))}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Edit slabs
                  </button>
                )}
              </div>
            </header>

            <div className="space-y-5 px-5 py-4">
              {/* The unified slab table. */}
              {(["PAYE", "SECONDARY", "ESCT"] as const).map((group) => {
                const rows = model.slabs.filter((s) => s.group === group);
                const banded = group !== "SECONDARY";
                return (
                  <div key={group}>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {GROUP_LABELS[group]}
                      </h3>
                      {editing && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setDraft({
                              ...model,
                              slabs: [
                                ...model.slabs,
                                group === "SECONDARY"
                                  ? { id: `new-${Date.now()}`, group, code: "NEW", label: "", lower: null, upper: null, rate: 10, accInclusive: false, order: 0 }
                                  : { id: `new-${Date.now()}`, group, code: group, label: "", lower: rows.length ? (rows[rows.length - 1].upper ?? 0) : 0, upper: null, rate: 10, accInclusive: false, order: rows.length * 10 },
                              ],
                            })
                          }
                        >
                          <Plus className="h-3 w-3" /> Add row
                        </button>
                      )}
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2 font-medium">Code</th>
                            <th className="px-3 py-2 font-medium">Lower (annual $)</th>
                            <th className="px-3 py-2 font-medium">Upper (annual $)</th>
                            <th className="px-3 py-2 font-medium">Rate %</th>
                            <th className="px-3 py-2 font-medium">ACC incl.</th>
                            <th className="px-3 py-2 font-medium">Order</th>
                            {editing && <th className="px-3 py-2" />}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const idx = model.slabs.indexOf(row);
                            const canonical = group === "SECONDARY" &&
                              ["SB", "S", "SH", "ST", "SA", "ND"].includes(row.code);
                            return (
                              <tr key={row.id} className="border-b border-border/60 last:border-0">
                                <td className="px-3 py-2">
                                  {group === "SECONDARY" && editing ? (
                                    <input
                                      className={`${inputCls} w-20 font-mono uppercase`}
                                      value={row.code}
                                      onChange={(e) => {
                                        const slabs = [...model.slabs];
                                        slabs[idx] = { ...row, code: e.target.value.toUpperCase() };
                                        setDraft({ ...model, slabs });
                                      }}
                                    />
                                  ) : (
                                    <span className="font-mono text-xs font-medium">{row.code}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {banded ? (
                                    editing ? (
                                      <NumCell
                                        value={row.lower}
                                        onChange={(v) => {
                                          const slabs = [...model.slabs];
                                          slabs[idx] = { ...row, lower: v };
                                          setDraft({ ...model, slabs });
                                        }}
                                      />
                                    ) : (
                                      <span className="tabular-nums text-muted-foreground">{money(row.lower)}</span>
                                    )
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {banded ? (
                                    editing ? (
                                      <NumCell
                                        value={row.upper}
                                        placeholder="open"
                                        onChange={(v) => {
                                          const slabs = [...model.slabs];
                                          slabs[idx] = { ...row, upper: v };
                                          setDraft({ ...model, slabs });
                                        }}
                                      />
                                    ) : (
                                      <span className="tabular-nums text-muted-foreground">{money(row.upper)}</span>
                                    )
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {editing ? (
                                    <div className="w-24">
                                      <NumCell
                                        value={row.rate}
                                        onChange={(v) => {
                                          const slabs = [...model.slabs];
                                          slabs[idx] = { ...row, rate: v ?? 0 };
                                          setDraft({ ...model, slabs });
                                        }}
                                      />
                                    </div>
                                  ) : (
                                    <span className="tabular-nums font-medium">{row.rate}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {group === "SECONDARY" ? (
                                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 accent-primary"
                                        checked={row.accInclusive}
                                        disabled={!editing}
                                        onChange={(e) => {
                                          const slabs = [...model.slabs];
                                          slabs[idx] = { ...row, accInclusive: e.target.checked };
                                          setDraft({ ...model, slabs });
                                        }}
                                      />
                                      {row.accInclusive ? "combined rate" : "levy on top"}
                                    </label>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      {group === "PAYE" ? "separate line" : "n/a"}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {banded && editing ? (
                                    <div className="w-20">
                                      <NumCell
                                        value={row.order}
                                        onChange={(v) => {
                                          const slabs = [...model.slabs];
                                          slabs[idx] = { ...row, order: v ?? 0 };
                                          setDraft({ ...model, slabs });
                                        }}
                                      />
                                    </div>
                                  ) : (
                                    <span className="tabular-nums text-xs text-muted-foreground">{row.order}</span>
                                  )}
                                </td>
                                {editing && (
                                  <td className="px-3 py-2 text-right">
                                    <button
                                      type="button"
                                      title={canonical ? "The six IRD codes must stay" : "Remove row"}
                                      disabled={canonical}
                                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                                      onClick={() =>
                                        setDraft({ ...model, slabs: model.slabs.filter((s) => s.id !== row.id) })
                                      }
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {/* The single-value rule families. */}
              <RulesEditor year={model} editing={editing} onChange={editing ? setDraft : undefined} />

              {editing && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium">Notes</label>
                  <textarea
                    className="min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={model.notes}
                    onChange={(e) => setDraft({ ...model, notes: e.target.value })}
                    placeholder="Where these rates came from (IRD references, verification date…)"
                  />
                </div>
              )}
            </div>

            <SimulatePanel year={year} />
          </section>
        );
      })}

      {taxYears.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No statutory rate sets yet — run the statutory seed
          (<code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">bun run db:seed:statutory</code>)
          to load the FY2026-27 set.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The single-value rule families (ACC / IETC / KiwiSaver / student loan).
// ---------------------------------------------------------------------------

function RulesEditor({
  year,
  editing,
  onChange,
}: {
  year: TaxYearAdminT;
  editing: boolean;
  onChange?: (y: TaxYearAdminT) => void;
}) {
  const p = year.params;
  const setParam = (patch: Partial<TaxYearAdminT["params"]>) =>
    onChange?.({ ...year, params: { ...p, ...patch } });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* ACC levy */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          ACC earners&apos; levy
        </h3>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Rate %</label>
            {editing ? (
              <NumCell value={p.acc?.rate ?? null} onChange={(v) => setParam({ acc: { ...p.acc!, rate: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.acc?.rate ?? "—"}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Max earnings $</label>
            {editing ? (
              <NumCell value={p.acc?.maxEarnings ?? null} onChange={(v) => setParam({ acc: { ...p.acc!, maxEarnings: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.acc ? money(p.acc.maxEarnings) : "—"}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Max levy $</label>
            {editing ? (
              <NumCell value={p.acc?.maxLevy ?? null} onChange={(v) => setParam({ acc: { ...p.acc!, maxLevy: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.acc ? money(p.acc.maxLevy) : "—"}</p>
            )}
          </div>
        </div>
      </div>

      {/* Student loan */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Student loan</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Rate %</label>
            {editing ? (
              <NumCell value={p.studentLoan?.rate ?? null} onChange={(v) => setParam({ studentLoan: { ...p.studentLoan!, rate: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.studentLoan?.rate ?? "—"}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Annual threshold $</label>
            {editing ? (
              <NumCell value={p.studentLoan?.annualThreshold ?? null} onChange={(v) => setParam({ studentLoan: { ...p.studentLoan!, annualThreshold: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.studentLoan ? money(p.studentLoan.annualThreshold) : "—"}</p>
            )}
          </div>
        </div>
      </div>

      {/* KiwiSaver */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">KiwiSaver</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Default employee %</label>
            {editing ? (
              <NumCell value={p.kiwiSaver?.defaultEmployeeRate ?? null} onChange={(v) => setParam({ kiwiSaver: { ...p.kiwiSaver!, defaultEmployeeRate: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.kiwiSaver?.defaultEmployeeRate ?? "—"}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Employer %</label>
            {editing ? (
              <NumCell value={p.kiwiSaver?.employerRate ?? null} onChange={(v) => setParam({ kiwiSaver: { ...p.kiwiSaver!, employerRate: v ?? 0 } })} />
            ) : (
              <p className="tabular-nums text-sm font-medium">{p.kiwiSaver?.employerRate ?? "—"}</p>
            )}
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[11px] text-muted-foreground">Allowed employee rates</label>
            {editing ? (
              <input
                className={inputCls}
                value={(p.kiwiSaver?.allowedEmployeeRates ?? []).join(", ")}
                onChange={(e) =>
                  setParam({
                    kiwiSaver: {
                      ...p.kiwiSaver!,
                      allowedEmployeeRates: e.target.value
                        .split(",")
                        .map((s) => Number(s.trim()))
                        .filter((n) => Number.isFinite(n) && n > 0),
                    },
                  })
                }
              />
            ) : (
              <p className="text-sm">
                {(p.kiwiSaver?.allowedEmployeeRates ?? []).map((r) => `${r}%`).join(" · ") || "—"}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* IETC */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          IETC (ME code)
        </h3>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {(
            [
              ["annualAmount", "Amount $"],
              ["lowerBound", "From $"],
              ["abateFrom", "Abates from $"],
              ["upperBound", "Gone at $"],
              ["abateRate", "Abate %"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label className="mb-1 block text-[11px] text-muted-foreground">{label}</label>
              {editing ? (
                <NumCell
                  value={p.ietc ? p.ietc[key] : null}
                  onChange={(v) => setParam({ ietc: { ...p.ietc!, [key]: v ?? 0 } })}
                />
              ) : (
                <p className="tabular-nums text-sm font-medium">{p.ietc ? p.ietc[key] : "—"}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Simulate panel (annualised gross → tax + ACC through the saved set).
// ---------------------------------------------------------------------------

function SimulatePanel({ year }: { year: TaxYearAdminT }) {
  const [open, setOpen] = useState(false);
  const [gross, setGross] = useState("60000");
  const [frequency, setFrequency] = useState<string>("ANNUAL");
  const [code, setCode] = useState<string>("M");
  const [studentLoan, setStudentLoan] = useState(false);
  const [stcRate, setStcRate] = useState("18");
  const [stcAcc, setStcAcc] = useState<"INC" | "PLUS">("INC");
  const [result, setResult] = useState<TaxSimulateResultT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isStc = code === "STC";

  function run() {
    startTransition(async () => {
      setError(null);
      const res = await simulateTax({
        rateSetId: year.id,
        code,
        gross: Number(gross) || 0,
        frequency,
        stcCertificateRate: isStc ? Number(stcRate) || null : null,
        stcAccTreatment: stcAcc,
        studentLoan,
      });
      if (!res.ok) {
        setResult(null);
        setError(res.error);
        return;
      }
      setResult(res.data);
    });
  }

  return (
    <div className="border-t border-border bg-muted/20 px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
      >
        <Wand2 className="h-4 w-4" />
        Simulate a payslip against &ldquo;{year.label}&rdquo;
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Runs the SAVED set through the statutory engine — unsaved edits in
            the table above are not included. Annualised gross answers &ldquo;what
            does a year at this salary deduct?&rdquo;; pick a pay frequency to
            see the per-period split instead.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium">Gross $</label>
              <input type="number" className={inputCls} value={gross} onChange={(e) => setGross(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Frequency</label>
              <select className={inputCls} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                {FREQUENCIES.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Tax code</label>
              <select className={inputCls} value={code} onChange={(e) => setCode(e.target.value)}>
                {SIM_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={studentLoan}
                  onChange={(e) => setStudentLoan(e.target.checked)}
                />
                Student loan (SL)
              </label>
            </div>
            {isStc && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium">IR23 certificate rate %</label>
                  <input type="number" className={inputCls} value={stcRate} onChange={(e) => setStcRate(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">ACC treatment</label>
                  <select className={inputCls} value={stcAcc} onChange={(e) => setStcAcc(e.target.value as "INC" | "PLUS")}>
                    <option value="INC">INC — rate includes the levy</option>
                    <option value="PLUS">PLUS — levy added on top</option>
                  </select>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <Wand2 className="h-4 w-4" /> Simulate
          </button>

          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {result && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">Income tax (PAYE)</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  ${result.tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                {result.ietc > 0 && (
                  <p className="mt-0.5 text-[11px] text-emerald-600">
                    incl. IETC credit −${result.ietc.toFixed(2)}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">ACC earners&apos; levy</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  ${result.acc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">method {result.method}</p>
              </div>
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <p className="text-xs text-muted-foreground">Total statutory deduction</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-primary">
                  ${result.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  slab basis ${result.annualised.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  {result.method === "PRIMARY" ? " (annualised)" : " (period gross — flat-rate code)"}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
