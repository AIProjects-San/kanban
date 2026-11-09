"use client";

// Recruitment R7 — salary structure editor
// (docs/RECRUITMENT_MODULE_PLAN.md §5). One modal for create + revise:
// pick the employee, edit the ANNUAL components (same shapes as the offer
// builder — fixed amounts or % of basic), and see the live monthly gross
// (annual ÷ 12). "Copy from signed offer" pulls the hire's signed offer
// components in one click (the payslip must match the appointment letter).

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { OfferComponentT, SalaryComponentT, SalaryStructureT, PayrollFrequencyT } from "@/lib/types";
import { PAYROLL_FREQUENCY_OPTIONS } from "@/lib/payroll-windows";
import { CtcSolverField } from "./ctc-solver-field";
import { createStructureFromOffer, saveSalaryStructure } from "@/server-actions/payroll";
import { getSalaryComponents } from "@/server-actions/payroll-components";
import { computeOffer, formatMoney } from "@/lib/offer-math";
import type { OpeningYtdRowT } from "@/lib/types";

const KIND_LABEL: Record<string, string> = {
  EARNING: "Earning",
  EMPLOYER_CONTRIBUTION: "Employer",
  DEDUCTION: "Deduction",
  STATISTICAL: "Statistical (info)",
};

/** P16 — one catalog row's window status against a date: null = unbounded
 * (no badge), else the badge text ("starts …" / "expired …" / "ends …"). */
function windowBadge(
  c: Pick<SalaryComponentT, "effectiveFrom" | "effectiveTo">,
  onDate: string,
): string | null {
  if (!c.effectiveFrom && !c.effectiveTo) return null;
  if (c.effectiveFrom && onDate && onDate < c.effectiveFrom) {
    return `starts ${c.effectiveFrom}`;
  }
  if (c.effectiveTo && onDate && onDate > c.effectiveTo) {
    return `expired ${c.effectiveTo}`;
  }
  if (c.effectiveTo) {
    return `ends ${c.effectiveTo}`;
  }
  return null;
}

export function StructureModal({
  open,
  onClose,
  onChanged,
  edit,
  employees,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** null → create a new structure. */
  edit: SalaryStructureT | null;
  /** id + name of every account (the employee picker). */
  employees: { userId: string; name: string }[];
}) {
  const [userId, setUserId] = useState("");
  const [components, setComponents] = useState<OfferComponentT[]>([]);
  const [notes, setNotes] = useState("");
  // P5 (F3.2) — the flexible-benefit cap (annual; 0 = no cap).
  const [maxBenefits, setMaxBenefits] = useState("0");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  // P10 (PR-B05) — the cadence this structure pays on (monthly default).
  const [frequency, setFrequency] = useState<PayrollFrequencyT>("MONTHLY");
  // P16 (PR-04) — the SSA opening YTD rows (annual amounts earned before
  // this system; seeds the fiscal year containing the effective date).
  const [openingYtd, setOpeningYtd] = useState<OpeningYtdRowT[]>([]);
  const [busy, setBusy] = useState(false);
  // F1.5 — the component catalog feeding the picker (loaded on open; a
  // failed load degrades to the blank-line path, never blocks the editor).
  const [catalog, setCatalog] = useState<SalaryComponentT[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setUserId(edit?.userId ?? ""); setComponents(edit ? edit.components.map((c) => ({ ...c })) : [{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 60_000 }]); setNotes(edit?.notes ?? ""); setMaxBenefits(String(edit?.maxBenefits ?? 0)); setEffectiveFrom(edit ? edit.effectiveFrom.slice(0, 10) : new Date().toISOString().slice(0, 10)); setFrequency(edit?.frequency ?? "MONTHLY"); setOpeningYtd(edit?.openingYtd ? edit.openingYtd.map((r) => ({ ...r })) : []); setCatalog([]); }
  }, [open, edit]);

  // F1.5 — catalog for the picker, loaded when the modal opens. The setState
  // rides an async callback (not a synchronous effect write), and a failed
  // load just leaves the picker hidden (blank-line path still works).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSalaryComponents().then((res) => {
      if (!cancelled && res.ok) setCatalog(res.data);
    });
    return () => { cancelled = true; };
  }, [open]);

  // Catalog rows worth offering: active, and not already on the structure
  // (one line per code — the duplicate would just confuse the math).
  const offerable = useMemo(
    () => catalog.filter((c) => c.isActive && !components.some((x) => x.key === c.code)),
    [catalog, components],
  );

  const addFromCatalog = (code: string) => {
    const row = catalog.find((c) => c.code === code);
    if (!row) return;
    setComponents((prev) => [...prev, {
      key: row.code,
      label: row.label,
      kind: row.kind,
      mode: row.mode,
      amount: row.defaultAmount,
      // S6 — the catalog's payment-days knob rides the snapshot (sparse:
      // only false is meaningful).
      ...(row.dependsOnPaymentDays === false ? { dependsOnPaymentDays: false } : {}),
    }]);
  };

  const annual = useMemo(() => computeOffer(components), [components]);
  const monthlyGross = Math.round((annual.earnings / 12) * 100) / 100;

  const patch = (i: number, part: Partial<OfferComponentT>) => {
    setComponents((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...part } : x)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) { toast.error("Pick an employee."); return; }
    if (components.some((x) => !x.key.trim() || !x.label.trim())) {
      toast.error("Every component needs a key and a label.");
      return;
    }
    setBusy(true);
    const res = await saveSalaryStructure({
      id: edit?.id,
      userId,
      components,
      notes,
      effectiveFrom,
      isActive: true,
      maxBenefits: Number(maxBenefits) || 0,
      frequency,
      // P16 — the opening rows ride the save (absent rows = the server
      // keeps the stored set; an explicitly emptied list clears them).
      ...(edit ? { openingYtd } : { openingYtd: openingYtd.length > 0 ? openingYtd : null }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(edit ? "Structure revised (the previous one is kept as history)." : "Salary structure saved.");
    onChanged();
    onClose();
  };

  const copyFromOffer = async () => {
    if (!userId) { toast.error("Pick an employee first."); return; }
    setBusy(true);
    const res = await createStructureFromOffer({ userId });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Structure created from the signed offer.");
    onChanged();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={edit ? `Structure — ${edit.userName}` : "New salary structure"}
      description="Annual components; monthly payslips divide by 12. Saving a new structure retires the employee's previous one (kept as history)."
      size="lg"
    >
      <form onSubmit={submit} className="space-y-3" data-testid="structure-form">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Employee">
            <select
              className="f-input"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={!!edit}
              data-testid="structure-employee"
            >
              <option value="">— Pick an employee —</option>
              {employees.map((u) => (
                <option key={u.userId} value={u.userId}>{u.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Effective from">
            <input
              type="date"
              className="f-input"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              data-testid="structure-effective"
            />
          </Field>
          <Field label="Pay cadence (P10)">
            <select
              className="f-input"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as PayrollFrequencyT)}
              data-testid="structure-frequency"
            >
              {PAYROLL_FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="space-y-1.5">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Annual components</div>
          {components.map((comp, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap" data-testid={`structure-component-${i}`}>
              <input
                className="f-input text-xs grow min-w-[110px]" placeholder="Label (e.g. Basic Salary)"
                value={comp.label}
                onChange={(e) => patch(i, {
                  label: e.target.value,
                  key: comp.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50),
                })}
                maxLength={120}
              />
              <select className="f-input text-xs w-auto" value={comp.kind} onChange={(e) => patch(i, { kind: e.target.value as OfferComponentT["kind"] })} aria-label="Kind">
                {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
              <select className="f-input text-xs w-auto" value={comp.mode} onChange={(e) => patch(i, { mode: e.target.value as OfferComponentT["mode"] })} aria-label="Mode">
                <option value="FIXED">$/yr</option>
                <option value="PERCENT_OF_BASIC">% basic</option>
              </select>
              <input
                className="f-input text-xs w-24" type="number" min={0} step="0.01"
                value={comp.amount}
                onChange={(e) => patch(i, { amount: Number(e.target.value) })}
                aria-label="Amount"
              />
              <span className="text-xs text-muted-foreground w-20 text-right tabular-nums">
                {comp.mode === "PERCENT_OF_BASIC" ? formatMoney(annual.resolved[comp.key] ?? 0) : ""}
              </span>
              {/* S6 — payment-days exemption: earnings scale with the
                  employment window and are docked by LOP unless exempt. */}
              {comp.kind === "EARNING" && (
                <label
                  className="inline-flex items-center gap-1 text-[0.625rem] text-muted-foreground cursor-pointer"
                  title="Window-exempt lines pay flat regardless of paid days / loss-of-pay (the catalog row's knob; this snapshot overrides it for this structure)."
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={comp.dependsOnPaymentDays !== false}
                    onChange={(e) => patch(i, { dependsOnPaymentDays: e.target.checked ? undefined : false })}
                    aria-label={`${comp.label || "component"} scales with payment days`}
                    data-testid={`structure-component-${i}-payment-days`}
                  />
                  day-scaled
                </label>
              )}
              <button
                type="button" className="f-btn f-btn-icon text-destructive" aria-label={`Remove ${comp.label || "component"}`}
                onClick={() => setComponents((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setComponents((prev) => [...prev, { key: "", label: "", kind: "EARNING", mode: "FIXED", amount: 0 }])} data-testid="structure-add-component">
            <Plus size={13} /> Add blank component
          </button>
          {/* F1.5 — the catalog picker: prefills a line from a curated
              definition (amount editable — the catalog row is a suggestion).
              P16: options carry their catalog validity window ("ends …") so
              the window is visible BEFORE a line is added. */}
          {catalog.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <select
                className="f-input text-xs w-auto"
                value=""
                onChange={(e) => { if (e.target.value) addFromCatalog(e.target.value); }}
                aria-label="Add from catalog"
                data-testid="structure-catalog-picker"
                disabled={offerable.length === 0}
              >
                <option value="">
                  {offerable.length === 0 ? "Catalog fully used" : "Add from catalog…"}
                </option>
                {offerable.map((c) => {
                  const badge = windowBadge(c, effectiveFrom);
                  return (
                    <option key={c.code} value={c.code}>
                      {c.label} ({c.code}){badge ? ` · ${badge}` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          {/* P16 — client-side pre-check of the server's refusal: lines whose
              catalog window doesn't cover the effective date are named here
              (the server still refuses; this makes the reason visible before
              the round-trip). */}
          {(() => {
            const offending = components.flatMap((comp) => {
              const cat = catalog.find((c) => c.code === comp.key);
              if (!cat) return [];
              const badge = windowBadge(cat, effectiveFrom);
              return badge && (badge.startsWith("starts ") || badge.startsWith("expired "))
                ? [`${comp.key} — ${badge}`]
                : [];
            });
            if (offending.length === 0) return null;
            return (
              <div className="text-xs text-amber-600" data-testid="structure-window-warnings">
                Outside the catalog window at {effectiveFrom}: {offending.join("; ")}. Saving will be refused until the effective date or the component changes.
              </div>
            );
          })()}
        </div>

        {/* Live totals */}
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" data-testid="structure-totals">
          <div><div className="text-muted-foreground">Annual earnings</div><div className="font-semibold tabular-nums">{formatMoney(annual.earnings)}</div></div>
          <div><div className="text-muted-foreground">Employer / yr</div><div className="font-semibold tabular-nums">{formatMoney(annual.employerContributions)}</div></div>
          <div><div className="text-muted-foreground">Annual CTC</div><div className="font-semibold tabular-nums text-emerald-600">{formatMoney(annual.ctc)}</div></div>
          <div><div className="text-muted-foreground">Monthly gross</div><div className="font-semibold tabular-nums text-primary">${monthlyGross.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>
        </div>

        {/* P12 (PR-B20/RJ-B14) — the CTC solver: enter the target annual
            CTC, the pure kernel solves the basic that hits it (fixed
            amounts + percent rates held constant), the solved amount lands
            in the basic line above. */}
        <CtcSolverField
          components={components}
          onSolved={(base, baseKey) => setComponents((prev) => prev.map((c) => (c.key === baseKey ? { ...c, amount: base } : c)))}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Notes (audit only)">
            <input className="f-input text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2_000} />
          </Field>
          <Field label="Flexible-benefit cap ($/year, 0 = no cap)">
            <input
              className="f-input text-xs" type="number" min={0} step={50}
              value={maxBenefits} onChange={(e) => setMaxBenefits(e.target.value)}
              data-testid="structure-max-benefits"
            />
          </Field>
        </div>

        {/* P16 (PR-04) — the SSA opening YTD rows: annual amounts earned
            before this system (the mid-fiscal-year joiner's prior-employer
            YTD). They seed the fiscal year containing this structure's
            effective date in every payslip's read-time YTD; empty = none. */}
        <div className="rounded-md border border-border px-3 py-2 space-y-1.5" data-testid="structure-opening-block">
          <div className="flex items-center justify-between">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Opening YTD balances (annual, earned before Fernly)
            </div>
            <button
              type="button" className="f-btn f-btn-ghost text-xs"
              onClick={() => setOpeningYtd((prev) => [...prev, { key: "", label: "", side: "EARNING", amount: 0 }])}
              data-testid="structure-opening-add"
            >
              <Plus size={13} /> Add opening row
            </button>
          </div>
          {openingYtd.length === 0 && (
            <div className="text-xs text-muted-foreground">
              None — payslip YTD starts from this system's first slip. Add rows only for joiners who earned
              under a previous employer inside the same fiscal year (the benchmark's SSA opening balances).
            </div>
          )}
          {openingYtd.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap" data-testid={`structure-opening-${i}`}>
              <input
                className="f-input text-xs grow min-w-[100px]" placeholder="Code (e.g. basic)"
                value={row.key} maxLength={60}
                onChange={(e) => setOpeningYtd((prev) => prev.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
                aria-label="Opening component code"
              />
              <input
                className="f-input text-xs grow min-w-[100px]" placeholder="Label"
                value={row.label} maxLength={120}
                onChange={(e) => setOpeningYtd((prev) => prev.map((r, idx) => (idx === i ? { ...r, label: e.target.value } : r)))}
                aria-label="Opening component label"
              />
              <select
                className="f-input text-xs w-auto" value={row.side}
                onChange={(e) => setOpeningYtd((prev) => prev.map((r, idx) => (idx === i ? { ...r, side: e.target.value as OpeningYtdRowT["side"] } : r)))}
                aria-label="Opening side"
              >
                <option value="EARNING">Earning</option>
                <option value="DEDUCTION">Deduction</option>
              </select>
              <input
                className="f-input text-xs w-28" type="number" min={0} step="0.01"
                value={row.amount}
                onChange={(e) => setOpeningYtd((prev) => prev.map((r, idx) => (idx === i ? { ...r, amount: Number(e.target.value) } : r)))}
                aria-label="Opening annual amount"
              />
              <button
                type="button" className="f-btn f-btn-icon text-destructive" aria-label="Remove opening row"
                onClick={() => setOpeningYtd((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {openingYtd.length > 0 && (
            <div className="text-xs text-muted-foreground" data-testid="structure-opening-total">
              Opening gross {formatMoney(openingYtd.filter((r) => r.side === "EARNING").reduce((s, r) => s + (Number(r.amount) || 0), 0))}
              {" · "}opening net {formatMoney(openingYtd.reduce((s, r) => s + (Number(r.amount) || 0) * (r.side === "EARNING" ? 1 : -1), 0))}
              {" — "}added to every YTD figure in the fiscal year of {effectiveFrom}.
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {!edit && (
            <button type="button" className="f-btn f-btn-ghost mr-auto" disabled={busy || !userId} onClick={() => void copyFromOffer()} data-testid="structure-from-offer">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} Copy from signed offer
            </button>
          )}
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="structure-save">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} {edit ? "Save revision" : "Save structure"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
