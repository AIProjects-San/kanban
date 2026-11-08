"use client";

// P1 (PR-12/PR-B10, F2.3) — the manual PayAdjustment writer + the adapter
// row list (payroll:manage). One modal, two panes: the form (top) and the
// row list with statuses (PENDING waiting for its run, CONSUMED with the
// consuming run's period, SKIPPED with its reason). The semantic rules
// (percent-of-net is deduction-only, endPeriod order, label-or-code) come
// from the pure kernel's validateAdjustmentInput — the server enforces
// them, the form mirrors them so the user never submits a guaranteed
// refusal.

import { useCallback, useEffect, useState } from "react";
import { CircleDollarSign, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import type { PayAdjustmentT } from "@/lib/types";
import { createPayAdjustment, listPayAdjustments } from "@/server-actions/payroll";
import { validateAdjustmentInput, ADJUSTMENT_CALC_MODES } from "@/lib/pay-adjustment";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  employees: Array<{ userId: string; name: string }>;
  /** Shown in the form as the preselected period (the selected run's). */
  defaultPeriod?: string;
}

type Side = "EARNING" | "DEDUCTION";
type Recurrence = "ONE_SHOT" | "RECURRING" | "OVERWRITE";
type CalcMode = "FIXED" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  INCENTIVE: "Incentive",
  ENCASHMENT: "Leave encashment",
  ARREARS: "Arrears",
  LWP_CREDIT: "LWP credit",
  RETENTION_BONUS: "Retention bonus",
  BENEFIT_PAYOUT: "Benefit payout",
  WITHHOLDING_RELEASE: "Withholding release",
};

export function PayAdjustmentModal({ open, onClose, onChanged, employees, defaultPeriod }: Props) {
  const [rows, setRows] = useState<PayAdjustmentT[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Form state (kept flat — the shape mirrors createPayAdjustmentSchema).
  const [userId, setUserId] = useState("");
  const [label, setLabel] = useState("");
  const [componentCode, setComponentCode] = useState("");
  const [side, setSide] = useState<Side>("EARNING");
  const [sourceType, setSourceType] = useState<"MANUAL" | "INCENTIVE">("MANUAL");
  const [recurrence, setRecurrence] = useState<Recurrence>("ONE_SHOT");
  const [calcMode, setCalcMode] = useState<CalcMode>("FIXED");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [period, setPeriod] = useState(defaultPeriod ?? "");
  const [endPeriod, setEndPeriod] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await listPayAdjustments();
    if (res.ok) setRows(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setUserId(employees[0]?.userId ?? ""); setPeriod(defaultPeriod ?? ""); setEndPeriod(""); }
  }, [open, load, employees, defaultPeriod]);

  const percentMode = calcMode === "PERCENT_OF_GROSS" || calcMode === "PERCENT_OF_NET";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = {
      userId,
      sourceType,
      componentCode: componentCode.trim(),
      label: label.trim(),
      side,
      recurrence,
      calcMode,
      percent: percentMode ? Number(percent) : null,
      amount: calcMode === "FIXED" ? Number(amount) : 0,
      period,
      endPeriod: recurrence === "RECURRING" && endPeriod ? endPeriod : null,
      note: note.trim(),
    };
    // The kernel's own rule — refuse client-side exactly like the server.
    const semantic = validateAdjustmentInput({
      side: input.side,
      recurrence: input.recurrence,
      calcMode: input.calcMode,
      percent: input.percent,
      amount: input.amount,
      period: input.period,
      endPeriod: input.endPeriod,
      label: input.label,
      componentCode: input.componentCode,
    });
    if (semantic) { toast.error(semantic); return; }
    if (!input.userId || !input.period) { toast.error("Pick an employee and a period."); return; }
    setBusy(true);
    const res = await createPayAdjustment(input);
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Adjustment queued — it lands on that period's run.");
    setLabel(""); setComponentCode(""); setAmount(""); setPercent(""); setNote("");
    await load();
    onChanged();
  };

  return (
    <Modal open={open} onClose={onClose} title="Adjustments" size="lg"
      description="One-off, recurring and overwrite adjustments queue here and land on the run covering their period (manual edits never rewrite a paid run).">
      <div className="space-y-5">
        <form onSubmit={submit} className="space-y-3" data-testid="adjustment-form">
          <FormRow>
            <Field label="Employee">
              <select id="adj-user" className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="adjustment-user">
                {employees.map((e) => <option key={e.userId} value={e.userId}>{e.name}</option>)}
              </select>
            </Field>
            <Field label="Label">
              <input id="adj-label" className="f-input" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder="Q4 bonus" maxLength={80} data-testid="adjustment-label" />
            </Field>
            <Field label="Catalog code (optional)">
              <input id="adj-code" className="f-input" value={componentCode} onChange={(e) => setComponentCode(e.target.value)}
                placeholder="BONUS" maxLength={40} data-testid="adjustment-code" />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Side">
              <select id="adj-side" className="f-input" value={side} onChange={(e) => setSide(e.target.value as Side)}>
                <option value="EARNING">Earning</option>
                <option value="DEDUCTION">Deduction</option>
              </select>
            </Field>
            <Field label="Source">
              <select id="adj-source" className="f-input" value={sourceType} onChange={(e) => setSourceType(e.target.value as "MANUAL" | "INCENTIVE")}>
                <option value="MANUAL">Manual</option>
                <option value="INCENTIVE">Incentive</option>
              </select>
            </Field>
            <Field label="Recurrence">
              <select id="adj-recurrence" className="f-input" value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
                <option value="ONE_SHOT">One-shot</option>
                <option value="RECURRING">Recurring</option>
                <option value="OVERWRITE">Overwrite a line</option>
              </select>
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Calc">
              <select id="adj-calc" className="f-input" value={calcMode} onChange={(e) => setCalcMode(e.target.value as CalcMode)}>
                {ADJUSTMENT_CALC_MODES.map((m) => (
                  <option key={m} value={m} disabled={m === "PERCENT_OF_NET" && side !== "DEDUCTION"}>
                    {m === "FIXED" ? "Fixed amount" : m === "PERCENT_OF_GROSS" ? "% of gross" : "% of net (deductions)"}
                  </option>
                ))}
              </select>
            </Field>
            {percentMode ? (
              <Field label="Percent (0–100)">
                <input id="adj-percent" type="number" min={0.01} max={100} step={0.01} className="f-input" value={percent}
                  onChange={(e) => setPercent(e.target.value)} placeholder="10" data-testid="adjustment-percent" />
              </Field>
            ) : (
              <Field label="Amount">
                <input id="adj-amount" type="number" min={0} step={0.01} className="f-input" value={amount}
                  onChange={(e) => setAmount(e.target.value)} placeholder="500" data-testid="adjustment-amount" />
              </Field>
            )}
            <Field label="First period">
              <input id="adj-period" type="month" className="f-input" value={period}
                onChange={(e) => setPeriod(e.target.value)} data-testid="adjustment-period" />
            </Field>
            {recurrence === "RECURRING" && (
              <Field label="Through period (optional)">
                <input id="adj-end" type="month" className="f-input" value={endPeriod}
                  onChange={(e) => setEndPeriod(e.target.value)} data-testid="adjustment-end-period" />
              </Field>
            )}
          </FormRow>
          <Field label="Note (optional)">
            <input id="adj-note" className="f-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div className="flex justify-end">
            <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="adjustment-submit">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Queue adjustment
            </button>
          </div>
        </form>

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <CircleDollarSign size={13} className="text-teal-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Adapter rows ({rows.length})
            </div>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {rows.map((r) => (
              <div key={r.id} className="px-3 py-2 flex items-center gap-2 text-sm" data-testid="adjustment-row">
                <span className={cnBadge(r.status)}>{r.status}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {r.userName} · {r.label || r.componentCode || "—"} ·{" "}
                    {r.calcMode === "FIXED"
                      ? `$${r.amount.toLocaleString("en-NZ")}`
                      : `${r.percent ?? "?"}% of ${r.calcMode === "PERCENT_OF_GROSS" ? "gross" : "net"}`}{" "}
                    · {r.side === "EARNING" ? "earning" : "deduction"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {SOURCE_LABELS[r.sourceType] ?? r.sourceType} · {r.recurrence === "ONE_SHOT" ? "one-shot" : r.recurrence === "RECURRING" ? `recurring${r.endPeriod ? ` through ${r.endPeriod}` : " (open)"}` : "overwrite"} · period {r.period}
                    {r.status === "CONSUMED" && r.consumedRunPeriod ? ` · paid in ${r.consumedRunPeriod}` : ""}
                    {r.status === "PENDING" && r.lastConsumedPeriod ? ` · last paid ${r.lastConsumedPeriod}` : ""}
                    {r.status === "SKIPPED" && r.skipReason ? ` · ${r.skipReason}` : ""}
                  </span>
                </span>
              </div>
            ))}
            {loaded && rows.length === 0 && (
              <div className="text-sm text-muted-foreground px-3 py-4 text-center">
                No adjustments yet — queue one above.
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function cnBadge(status: string): string {
  const base = "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0";
  if (status === "CONSUMED") return `${base} bg-emerald-500/10 text-emerald-600`;
  if (status === "SKIPPED") return `${base} bg-rose-500/10 text-rose-600`;
  return `${base} bg-amber-500/10 text-amber-600`;
}
