"use client";

// F1.5 — salary component catalog manager
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1). One modal for create +
// edit: define the workspace's component vocabulary (code, label, kind,
// mode, suggested amount) that the structure editor's picker offers.
// Snapshot discipline: structures keep their own copies, so edits here only
// change what the picker offers NEXT time — no stored payslip or structure
// line ever rewrites.

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { SalaryComponentT } from "@/lib/types";
import {
  getSalaryComponents,
  saveSalaryComponent,
  deleteSalaryComponent,
} from "@/server-actions/payroll-components";

const KIND_LABEL: Record<string, string> = {
  EARNING: "Earning",
  EMPLOYER_CONTRIBUTION: "Employer",
  DEDUCTION: "Deduction",
  STATISTICAL: "Statistical (info)",
};

const BLANK = {
  id: "",
  code: "",
  label: "",
  kind: "EARNING",
  mode: "FIXED",
  defaultAmount: 0,
  dependsOnPaymentDays: true,
  isActive: true,
  sortOrder: 0,
};

export function ComponentCatalogModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<SalaryComponentT[]>([]);
  const [editing, setEditing] = useState<typeof BLANK | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await getSalaryComponents();
    if (res.ok) setRows(res.data);
    else toast.error(res.error);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setEditing(null); setConfirmDeleteId(null); }
  }, [open]);

  // Rows load asynchronously whenever the modal opens (and after every
  // save/delete — `load` is the shared refresher).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    if (!editing.code.trim() || !editing.label.trim()) {
      toast.error("A code and a label are required.");
      return;
    }
    setBusy(true);
    const res = await saveSalaryComponent({
      id: editing.id || undefined,
      code: editing.code,
      label: editing.label,
      kind: editing.kind,
      mode: editing.mode,
      defaultAmount: Number(editing.defaultAmount),
      dependsOnPaymentDays: editing.dependsOnPaymentDays !== false,
      isActive: editing.isActive,
      sortOrder: Number(editing.sortOrder),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(editing.id ? "Component updated." : "Component added to the catalog.");
    setEditing(null);
    await load();
    onChanged();
  };

  const remove = async (id: string) => {
    setBusy(true);
    const res = await deleteSalaryComponent({ id });
    setBusy(false);
    setConfirmDeleteId(null);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Removed from the catalog — existing structures keep their copies.");
    await load();
    onChanged();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Component catalog"
      description="The vocabulary the structure editor picks from. Structures keep their own copies — edits here change only what the picker offers next time."
      size="lg"
    >
      <div className="space-y-3" data-testid="component-catalog">
        {/* List */}
        <div className="rounded-md border border-border divide-y divide-border max-h-56 overflow-y-auto" data-testid="component-catalog-list">
          {rows.map((r) => (
            <div key={r.id} className="px-2.5 py-2 flex items-center gap-2 flex-wrap text-xs" data-testid={`catalog-row-${r.code}`}>
              <span className="font-mono text-muted-foreground shrink-0">{r.code}</span>
              <span className={r.isActive ? "min-w-0 grow truncate" : "min-w-0 grow truncate text-muted-foreground line-through"}>{r.label}</span>
              <span className="shrink-0 text-muted-foreground">{KIND_LABEL[r.kind] ?? r.kind}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {r.mode === "PERCENT_OF_BASIC" ? `${r.defaultAmount}% basic` : `$${r.defaultAmount.toLocaleString("en-NZ")}/yr`}
              </span>
              {!r.dependsOnPaymentDays && (
                <span className="shrink-0 text-[0.625rem] font-medium px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-400">
                  window-exempt
                </span>
              )}
              <span className="flex items-center gap-1 shrink-0">
                <button
                  type="button" className="f-btn f-btn-ghost text-xs px-1.5 py-0.5"
                  onClick={() => setEditing({ ...r })}
                  aria-label={`Edit ${r.code}`}
                  disabled={busy}
                >
                  Edit
                </button>
                {confirmDeleteId === r.id ? (
                  <>
                    <button type="button" className="f-btn f-btn-primary text-xs px-1.5 py-0.5" disabled={busy} onClick={() => void remove(r.id)} aria-label={`Confirm delete ${r.code}`}>
                      {busy ? <Loader2 size={12} className="animate-spin" /> : null} Delete
                    </button>
                    <button type="button" className="f-btn f-btn-ghost text-xs px-1.5 py-0.5" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                  </>
                ) : (
                  <button
                    type="button" className="f-btn f-btn-icon text-destructive"
                    onClick={() => setConfirmDeleteId(r.id)}
                    aria-label={`Delete ${r.code}`}
                    disabled={busy}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="text-sm text-muted-foreground px-3 py-5 text-center">
              Empty catalog — add the workspace&apos;s component definitions below.
            </div>
          )}
        </div>

        {/* Editor */}
        {editing ? (
          <form onSubmit={submit} className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5" data-testid="catalog-editor">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Field label="Code">
                <input
                  className="f-input text-xs font-mono"
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, "_") })}
                  placeholder="basic"
                  maxLength={60}
                  disabled={!!editing.id}
                  data-testid="catalog-code"
                />
              </Field>
              <Field label="Label">
                <input
                  className="f-input text-xs"
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  placeholder="Basic Salary"
                  maxLength={120}
                  data-testid="catalog-label"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <Field label="Kind">
                <select className="f-input text-xs" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })} aria-label="Kind">
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              <Field label="Mode">
                <select className="f-input text-xs" value={editing.mode} onChange={(e) => setEditing({ ...editing, mode: e.target.value })} aria-label="Mode">
                  <option value="FIXED">$/yr</option>
                  <option value="PERCENT_OF_BASIC">% basic</option>
                </select>
              </Field>
              <Field label={editing.mode === "PERCENT_OF_BASIC" ? "Percent" : "Suggested $/yr"}>
                <input
                  className="f-input text-xs" type="number" min={0} step="0.01"
                  value={editing.defaultAmount}
                  onChange={(e) => setEditing({ ...editing, defaultAmount: Number(e.target.value) })}
                  data-testid="catalog-amount"
                />
              </Field>
              <Field label="Sort">
                <input
                  className="f-input text-xs" type="number" min={0} step={1}
                  value={editing.sortOrder}
                  onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })}
                  aria-label="Sort order"
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-xs" title="Window-exempt lines pay flat regardless of employment-window paid days and are not docked by loss-of-pay (PR-B02).">
              <input
                type="checkbox"
                checked={editing.dependsOnPaymentDays !== false}
                onChange={(e) => setEditing({ ...editing, dependsOnPaymentDays: e.target.checked })}
                data-testid="catalog-payment-days"
              />
              Scales with payment days (uncheck = flat / window-exempt)
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={editing.isActive}
                onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
              />
              Active (offered in the picker)
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="f-btn f-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="catalog-save">
                {busy ? <Loader2 size={14} className="animate-spin" /> : null} {editing.id ? "Save component" : "Add component"}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setEditing({ ...BLANK })} data-testid="catalog-add">
            + Add component definition
          </button>
        )}
      </div>
    </Modal>
  );
}
