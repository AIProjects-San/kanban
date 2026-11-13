"use client";

// P14 (PR-33) — the bulk salary structure assignment: ONE component set to
// many employees at once. The component set is picked FROM an existing
// active structure (copy semantics — the benchmark's bulk SSA tool assigns
// a structure, and Fernly's structures live per employee, so an existing
// one is the natural source), each employee's active structure is replaced
// in their own transaction with per-employee isolation (the P13 pattern),
// and the summary is loud + the counts honest.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { OfferComponentT, PayrollFrequencyT, SalaryStructureT } from "@/lib/types";
import { PAYROLL_FREQUENCY_OPTIONS } from "@/lib/payroll/payroll-windows";
import { bulkAssignStructure } from "@/server-actions/payroll-structures";
import { computeOffer, formatMoney } from "@/lib/offer-math";

export function BulkStructureModal({
  open,
  onClose,
  onChanged,
  employees,
  structures,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** id + name of every account (the employee picker). */
  employees: { userId: string; name: string }[];
  /** The active structures (the copy sources). */
  structures: SalaryStructureT[];
}) {
  const [sourceId, setSourceId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [frequency, setFrequency] = useState<PayrollFrequencyT>("MONTHLY");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setSourceId(structures[0]?.id ?? ""); setSelected(new Set()); setFrequency(structures[0]?.frequency ?? "MONTHLY"); setEffectiveFrom(new Date().toISOString().slice(0, 10)); setNotes(""); }
  }, [open, structures]);

  const source = structures.find((s) => s.id === sourceId) ?? null;
  const components: OfferComponentT[] = useMemo(
    () => (source ? source.components : []),
    [source],
  );
  const preview = useMemo(() => computeOffer(components), [components]);

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (components.length === 0) { toast.error("Pick a source structure with components."); return; }
    if (selected.size === 0) { toast.error("Pick at least one employee."); return; }
    setBusy(true);
    const res = await bulkAssignStructure({
      userIds: [...selected],
      components,
      notes,
      frequency,
      effectiveFrom,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    const { replaced, createdFresh, failures } = res.data;
    toast.success(`Bulk assignment done — ${replaced} replaced, ${createdFresh} first structure(s).`);
    if (failures.length > 0) {
      toast.error(
        `${failures.length} employee(s) failed: ${failures.map((f) => `${f.reason}`).join("; ")}.`,
        { duration: 10_000 },
      );
    }
    onChanged();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk structure assignment"
      description="Assign one component set to many employees at once — each employee's active structure is replaced (kept as history)."
      size="lg"
    >
      <form onSubmit={submit} className="space-y-3" data-testid="bulk-structure-modal">
        <Field label="Copy components from (an active structure)">
          <select
            className="f-input"
            value={sourceId}
            onChange={(e) => {
              setSourceId(e.target.value);
              const next = structures.find((s) => s.id === e.target.value);
              if (next) setFrequency(next.frequency);
            }}
            data-testid="bulk-source"
          >
            {structures.map((s) => (
              <option key={s.id} value={s.id}>
                {s.userName} — {s.jobTitle || "no title"} ({s.frequency.toLowerCase()})
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Cadence">
            <select
              className="f-input"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as PayrollFrequencyT)}
              data-testid="bulk-frequency"
            >
              {PAYROLL_FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Effective from">
            <input
              type="date"
              className="f-input"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              data-testid="bulk-effective"
            />
          </Field>
          <Field label="Notes (audit only)">
            <input className="f-input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2_000} data-testid="bulk-notes" />
          </Field>
        </div>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" data-testid="bulk-totals">
          <div><div className="text-muted-foreground">Components</div><div className="font-semibold tabular-nums">{components.length}</div></div>
          <div><div className="text-muted-foreground">Annual earnings</div><div className="font-semibold tabular-nums">{formatMoney(preview.earnings)}</div></div>
          <div><div className="text-muted-foreground">Employer / yr</div><div className="font-semibold tabular-nums">{formatMoney(preview.employerContributions)}</div></div>
          <div><div className="text-muted-foreground">Annual CTC</div><div className="font-semibold tabular-nums text-emerald-600">{formatMoney(preview.ctc)}</div></div>
        </div>

        <div className="rounded-md border border-border" data-testid="bulk-employees">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Users size={14} className="text-sky-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Employees ({selected.size} selected)
            </div>
            <button
              type="button"
              className="f-btn f-btn-ghost text-xs ml-auto"
              onClick={() => setSelected(new Set(employees.map((e) => e.userId)))}
              data-testid="bulk-select-all"
            >
              Select all
            </button>
            <button
              type="button"
              className="f-btn f-btn-ghost text-xs"
              onClick={() => setSelected(new Set())}
              data-testid="bulk-clear"
            >
              Clear
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto divide-y divide-border">
            {employees.map((e) => (
              <label key={e.userId} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                <input
                  type="checkbox"
                  checked={selected.has(e.userId)}
                  onChange={() => toggle(e.userId)}
                  data-testid={`bulk-employee-${e.userId}`}
                />
                <span className="truncate">{e.name}</span>
                {structures.find((s) => s.userId === e.userId && s.isActive) && (
                  <span className="ml-auto text-[0.625rem] text-muted-foreground shrink-0">
                    replaces {structures.find((s) => s.userId === e.userId && s.isActive)?.frequency.toLowerCase()} structure
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary" disabled={busy || selected.size === 0 || components.length === 0} data-testid="bulk-submit">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />} Assign to {selected.size || "…"} employee(s)
          </button>
        </div>
      </form>
    </Modal>
  );
}
