"use client";

// P5 (PR-15–18, PR-B04, F3.2) — the Benefits panel: elections with live
// accrued balances, the structure cap, elect/re-elect, cancel, and the
// claim writer (consumes accrued balance, pays via the adapter). The cap
// rule comes from the pure planBenefitElection kernel — the server enforces
// it, the form previews it.

import { useCallback, useEffect, useState } from "react";
import { HeartPulse, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import type { BenefitsOverviewT } from "@/lib/types";
import { getBenefitsOverview, electBenefit, cancelBenefitElection, claimBenefit } from "@/server-actions/payroll-benefits";
import { planBenefitElection, planBenefitClaim } from "@/lib/benefits";
import { currentPeriod } from "@/lib/payroll-math";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  employees: Array<{ userId: string; name: string }>;
}

export function BenefitsModal({ open, onClose, onChanged, employees }: Props) {
  const [data, setData] = useState<BenefitsOverviewT | null>(null);
  const [userId, setUserId] = useState(employees[0]?.userId ?? "");
  const [componentCode, setComponentCode] = useState("");
  const [label, setLabel] = useState("");
  const [annualAmount, setAnnualAmount] = useState("");
  const [claimAmount, setClaimAmount] = useState("");
  const [payoutPeriod, setPayoutPeriod] = useState(currentPeriod());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [claimingRow, setClaimingRow] = useState<string | null>(null);

  const year = new Date().getUTCFullYear();
  const load = useCallback(async () => {
    const res = await getBenefitsOverview({ year });
    if (res.ok) setData(res.data);
    else toast.error(res.error);
  }, [year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setUserId(employees[0]?.userId ?? ""); setClaimingRow(null); }
  }, [open, load, employees]);

  const selectedCap = () => {
    const row = data?.rows.find((r) => r.userId === userId && r.status === "ACTIVE");
    return row?.cap ?? 0;
  };
  const currentTotal = () =>
    (data?.rows ?? []).filter((r) => r.userId === userId && r.status === "ACTIVE")
      .reduce((s, r) => s + r.annualAmount, 0);
  const currentComponent = () =>
    (data?.rows ?? []).filter((r) => r.userId === userId && r.componentCode === componentCode.trim() && r.status === "ACTIVE")
      .reduce((s, r) => s + r.annualAmount, 0);

  const electionPlan = annualAmount !== "" && Number.isFinite(Number(annualAmount))
    ? planBenefitElection({
        maxBenefits: selectedCap(),
        currentAnnualTotal: currentTotal(),
        currentComponentAnnual: currentComponent(),
        annualAmount: Number(annualAmount),
      })
    : null;

  const submitElection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!electionPlan?.ok) return;
    setBusy(true);
    const res = await electBenefit({
      userId, year, componentCode: componentCode.trim(), label: label.trim(), annualAmount: Number(annualAmount),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Benefit election saved — it accrues at each run lock (÷12, paid-days-scaled).");
    setComponentCode(""); setLabel(""); setAnnualAmount("");
    await load();
    onChanged();
  };

  const cancel = async (electionId: string) => {
    setBusy(true);
    const res = await cancelBenefitElection({ electionId });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Election cancelled — the accrued balance stays claimable.");
    await load();
    onChanged();
  };

  const claimPlan = claimingRow && claimAmount !== "" && Number.isFinite(Number(claimAmount))
    ? planBenefitClaim({
        balance: data?.rows.find((r) => r.id === claimingRow)?.balance ?? 0,
        amount: Number(claimAmount),
      })
    : null;

  const submitClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    const row = data?.rows.find((r) => r.id === claimingRow);
    if (!row || !claimPlan?.ok) return;
    setBusy(true);
    const res = await claimBenefit({
      userId: row.userId, year: row.year, componentCode: row.componentCode,
      amount: Number(claimAmount), payoutPeriod, note: note.trim(),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Claim queued — $${res.data.amount.toLocaleString("en-NZ")} onto the ${payoutPeriod} run.`);
    setClaimingRow(null); setClaimAmount(""); setNote("");
    await load();
    onChanged();
  };

  return (
    <Modal open={open} onClose={onClose} title="Flexible benefits" size="lg"
      description="Yearly elections (capped by each employee's structure) accrue at every run lock — annual ÷ 12, paid-days-scaled — into a claimable balance. Claims pay through the adjustments adapter.">
      <div className="space-y-5">
        <form onSubmit={submitElection} className="space-y-3" data-testid="benefit-election-form">
          <FormRow>
            <Field label="Employee">
              <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="benefit-user">
                {employees.map((emp) => <option key={emp.userId} value={emp.userId}>{emp.name}</option>)}
              </select>
            </Field>
            <Field label="Component code">
              <input className="f-input" value={componentCode} onChange={(e) => setComponentCode(e.target.value)}
                placeholder="HEALTH" maxLength={40} data-testid="benefit-code" />
            </Field>
            <Field label="Label">
              <input className="f-input" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder="Health insurance" maxLength={80} />
            </Field>
            <Field label="Annual amount">
              <input className="f-input" type="number" min={0.01} step={0.01} value={annualAmount}
                onChange={(e) => setAnnualAmount(e.target.value)} placeholder="1200" data-testid="benefit-annual" />
            </Field>
          </FormRow>
          {electionPlan && !electionPlan.ok && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600">
              {electionPlan.reason}
            </div>
          )}
          <div className="flex justify-end">
            <button type="submit" className="f-btn f-btn-primary" disabled={busy || !electionPlan?.ok || !componentCode.trim()} data-testid="benefit-elect-btn">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Elect benefit
            </button>
          </div>
        </form>

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <HeartPulse size={13} className="text-pink-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {year} elections ({data?.rows.length ?? 0})
            </div>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {(data?.rows ?? []).map((r) => (
              <div key={r.id} className="px-3 py-2 flex items-center gap-2 text-sm" data-testid="benefit-row">
                <span className={r.status === "ACTIVE" ? "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-emerald-500/10 text-emerald-600" : "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-muted text-muted-foreground"}>
                  {r.status}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {r.userName} · {r.label} · ${r.annualAmount.toLocaleString("en-NZ")}/year
                    {r.cap > 0 ? ` · cap $${r.cap.toLocaleString("en-NZ")}` : ""}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    accrued balance ${r.balance.toLocaleString("en-NZ")}
                    {r.status === "CANCELLED" ? " · cancelled (balance stays claimable)" : ""}
                  </span>
                </span>
                {r.status === "ACTIVE" && (
                  <button className="f-btn f-btn-ghost text-xs shrink-0" disabled={busy} onClick={() => void cancel(r.id)} type="button">
                    <X size={12} /> Cancel
                  </button>
                )}
                <button
                  className="f-btn f-btn-ghost text-xs shrink-0"
                  disabled={r.balance <= 0}
                  onClick={() => { setClaimingRow(r.id); setClaimAmount(""); }}
                  type="button"
                  data-testid={`benefit-claim-btn-${r.componentCode}`}
                >
                  Claim
                </button>
              </div>
            ))}
            {data && data.rows.length === 0 && (
              <div className="text-sm text-muted-foreground px-3 py-4 text-center">
                No elections for {year} yet.
              </div>
            )}
          </div>
        </div>

        {claimingRow && (() => {
          const row = data?.rows.find((r) => r.id === claimingRow);
          if (!row) return null;
          return (
            <form onSubmit={submitClaim} className="rounded-md border border-border p-3 space-y-3" data-testid="benefit-claim-form">
              <div className="text-sm">
                <div className="font-medium text-foreground">Claim — {row.userName} · {row.label}</div>
                <div className="text-muted-foreground text-[0.8125rem]">${row.balance.toLocaleString("en-NZ")} accrued</div>
              </div>
              <FormRow>
                <Field label="Amount">
                  <input className="f-input" type="number" min={0.01} max={row.balance} step={0.01}
                    value={claimAmount} onChange={(e) => setClaimAmount(e.target.value)} data-testid="benefit-claim-amount" />
                </Field>
                <Field label="Payout period">
                  <input className="f-input" type="month" value={payoutPeriod}
                    onChange={(e) => setPayoutPeriod(e.target.value)} />
                </Field>
                <Field label="Note (optional)">
                  <input className="f-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                </Field>
              </FormRow>
              {claimPlan && !claimPlan.ok && (
                <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{claimPlan.reason}</div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="f-btn f-btn-ghost" onClick={() => setClaimingRow(null)}>Cancel</button>
                <button type="submit" className="f-btn f-btn-primary" disabled={busy || !claimPlan?.ok} data-testid="benefit-claim-submit">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <HeartPulse size={15} />} Claim
                </button>
              </div>
            </form>
          );
        })()}
      </div>
    </Modal>
  );
}
