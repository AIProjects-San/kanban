"use client";

// P6 (PR-20/PR-23, PR-T01) — the retention-bonus modal: total, installments,
// first period; the pure planRetentionBonus kernel previews the split (the
// last installment absorbs rounding); the writer notifies the employee
// (in-app + outbox email) and pays through the adjustments adapter.

import { useState } from "react";
import { Award, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import { createRetentionBonus } from "@/server-actions/payroll-retention";
import { planRetentionBonus, periodPlusMonths } from "@/lib/payroll/retention-bonus";
import { currentPeriod } from "@/lib/payroll/payroll-math";

export function RetentionBonusModal({
  open,
  onClose,
  onChanged,
  employees,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  employees: Array<{ userId: string; name: string }>;
}) {
  const [userId, setUserId] = useState(employees[0]?.userId ?? "");
  const [totalAmount, setTotalAmount] = useState("");
  const [installments, setInstallments] = useState("1");
  const [firstPeriod, setFirstPeriod] = useState(currentPeriod());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const total = Number(totalAmount);
  const n = Number(installments);
  const plan = totalAmount !== "" && Number.isFinite(total) && Number.isInteger(n) && n >= 1
    ? planRetentionBonus({ totalAmount: total, installments: n })
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plan?.ok) return;
    setBusy(true);
    const res = await createRetentionBonus({
      userId, totalAmount: total, installments: n, firstPeriod, note: note.trim(),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Retention bonus queued — ${n} installment${n === 1 ? "" : "s"} from ${firstPeriod}; the employee was notified.`);
    setTotalAmount(""); setNote("");
    onChanged();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Retention bonus"
      description="Pay a bonus in monthly installments through the adjustments adapter. The employee is notified in-app and by email.">
      <form onSubmit={submit} className="space-y-3" data-testid="retention-form">
        <FormRow>
          <Field label="Employee">
            <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="retention-user">
              {employees.map((emp) => <option key={emp.userId} value={emp.userId}>{emp.name}</option>)}
            </select>
          </Field>
          <Field label="Total amount">
            <input className="f-input" type="number" min={0.01} step={0.01}
              value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="1000" data-testid="retention-total" />
          </Field>
          <Field label="Installments (monthly)">
            <input className="f-input" type="number" min={1} max={12} step={1}
              value={installments} onChange={(e) => setInstallments(e.target.value)}
              data-testid="retention-installments" />
          </Field>
          <Field label="First period">
            <input className="f-input" type="month" value={firstPeriod}
              onChange={(e) => setFirstPeriod(e.target.value)} data-testid="retention-period" />
          </Field>
        </FormRow>
        <Field label="Note (optional)">
          <input className="f-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder="e.g. Key contributor retention" />
        </Field>
        {plan && !plan.ok && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{plan.reason}</div>
        )}
        {plan?.ok && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {n === 1
              ? `$${total.toLocaleString("en-NZ")} on the ${firstPeriod} run.`
              : `${n} installments: ${plan.perInstallment.toLocaleString("en-NZ", { style: "currency", currency: "NZD" })}/month × ${n - 1} + a final ${plan.lastInstallment.toLocaleString("en-NZ", { style: "currency", currency: "NZD" })} — ${firstPeriod} through ${periodPlusMonths(firstPeriod, n - 1)}.`}
          </div>
        )}
        <div className="flex justify-end">
          <button type="submit" className="f-btn f-btn-primary" disabled={busy || !plan?.ok} data-testid="retention-submit">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Award size={15} />} Create retention bonus
          </button>
        </div>
      </form>
    </Modal>
  );
}
