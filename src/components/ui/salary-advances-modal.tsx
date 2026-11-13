"use client";

// P39 (EM-16's advances half, EX-03 lite) — the salary-advances modal
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P39). Issue an advance
// (N equal installments from a start period — the recovery rides the P1
// PayAdjustment adapter as DEDUCTION rows) and watch the live outstanding
// (the paychecks' returned money, provenance-linked through sourceId).

import { useCallback, useEffect, useState } from "react";
import { CircleDollarSign, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import { cn } from "@/lib/utils";
import type { SalaryAdvanceT } from "@/lib/types";
import { getSalaryAdvances, issueSalaryAdvance } from "@/server-actions/salary-advances";
import { formatMoney } from "@/lib/format";

export function SalaryAdvancesModal({
  open, onClose, onChanged, employees,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  employees: { userId: string; name: string }[];
}) {
  const [advances, setAdvances] = useState<SalaryAdvanceT[] | null>(null);
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("500");
  const [installments, setInstallments] = useState("4");
  const [startPeriod, setStartPeriod] = useState("2026-12");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getSalaryAdvances();
    if (res.ok) setAdvances(res.data);
    else { toast.error(res.error); setAdvances([]); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setUserId(""); setAmount("500"); setInstallments("4"); setReason(""); }
  }, [open, load]);

  const issue = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await issueSalaryAdvance({
      userId,
      amount: Number(amount),
      installments: Number(installments) || 1,
      startPeriod,
      reason,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Advance issued — ${installments} recovery installment${Number(installments) === 1 ? "" : "s"} from ${startPeriod}.`);
    setUserId("");
    setAmount("500");
    setReason("");
    await load();
    onChanged();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Salary advances"
      description="Issue an advance — the recovery rides the payroll adapter as per-paycheck deductions, and the outstanding is a full-and-final receivable"
      size="lg"
    >
      <div className="space-y-2" data-testid="salary-advances-list">
        {advances === null && <div className="text-sm text-muted-foreground py-2">Loading advances…</div>}
        {advances !== null && advances.map((a) => (
          <div
            key={a.id}
            className="rounded-md border border-border px-3 py-2 flex items-center gap-3"
            data-testid={`advance-${a.userName}`}
          >
            <CircleDollarSign size={14} className="text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate flex items-center gap-1.5">
                <span className="truncate">{a.userName}</span>
                <span className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
                  a.status === "RECOVERED" ? "bg-success/15 text-success" : "bg-primary/10 text-primary",
                )}>
                  {a.status === "RECOVERED" ? "Recovered" : "Open"}
                </span>
              </div>
              <div className="text-[0.625rem] text-muted-foreground truncate">
                {formatMoney(a.amount)} · {a.installments} installment{a.installments === 1 ? "" : "s"} from {a.startPeriod}
                {a.issuedBy ? ` · issued by ${a.issuedBy}` : ""}
                {a.reason ? ` · ${a.reason}` : ""}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className={cn("text-xs font-medium tabular-nums", a.outstanding > 0 ? "text-destructive" : "text-success")}>
                {a.outstanding > 0 ? `${formatMoney(a.outstanding)} outstanding` : "recovered"}
              </div>
              <div className="text-[0.625rem] text-muted-foreground">{a.summary.split(" · ")[1] ?? ""}</div>
            </div>
          </div>
        ))}
        {advances !== null && advances.length === 0 && (
          <div className="text-sm text-muted-foreground">No advances issued yet.</div>
        )}
      </div>

      <form onSubmit={issue} className="mt-4 pt-4 border-t border-border space-y-3" data-testid="advance-issue-form">
        <FormRow>
          <Field label="Employee">
            <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="advance-employee" required>
              <option value="" disabled>Pick an employee…</option>
              {employees.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Amount ($)">
            <input
              type="number" min={0.01} step={0.01} className="f-input"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              data-testid="advance-amount" required
            />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Installments (1–24)">
            <input
              type="number" min={1} max={24} className="f-input"
              value={installments} onChange={(e) => setInstallments(e.target.value)}
              data-testid="advance-installments"
            />
          </Field>
          <Field label="First recovery period (YYYY-MM)">
            <input
              className="f-input" value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)}
              pattern="\d{4}-(0[1-9]|1[0-2])" title="YYYY-MM"
              data-testid="advance-start-period"
            />
          </Field>
        </FormRow>
        <Field label="Reason (optional)">
          <input className="f-input" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. relocation — deducted over 4 paychecks" />
        </Field>
        <button type="submit" className="f-btn f-btn-primary" disabled={busy || !userId} data-testid="advance-issue-btn">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Issue advance
        </button>
      </form>
    </Modal>
  );
}
