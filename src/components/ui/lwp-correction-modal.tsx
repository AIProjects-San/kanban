"use client";

// P4 (PR-14/PR-B12, F3.1) — the LWP-correction modal: the stored facts, the
// remaining reversible days, a live-priced preview (the same pure
// planLwpCorrection kernel the server runs), and the refund onto a chosen
// payout period.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { LwpCorrectionPreviewT } from "@/lib/types";
import { previewLwpCorrection, reverseLwpDays } from "@/server-actions/payroll-lwp";
import { planLwpCorrection } from "@/lib/payroll/lwp-correction";
import { currentPeriod } from "@/lib/payroll/payroll-math";

export function LwpCorrectionModal({
  open,
  onClose,
  payslipId,
  onReversed,
}: {
  open: boolean;
  onClose: () => void;
  payslipId: string;
  onReversed: () => Promise<void> | void;
}) {
  const [facts, setFacts] = useState<LwpCorrectionPreviewT | null>(null);
  const [daysStr, setDaysStr] = useState("");
  const [payoutPeriod, setPayoutPeriod] = useState(currentPeriod());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await previewLwpCorrection({ payslipId });
    if (res.ok) setFacts(res.data);
    else toast.error(res.error);
  }, [payslipId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setFacts(null); setDaysStr(""); setNote(""); void load(); }
  }, [open, load]);

  const days = Number(daysStr);
  const plan = facts && daysStr !== "" && Number.isFinite(days)
    ? planLwpCorrection({
        storedLopDays: facts.storedLopDays,
        storedLopAmount: facts.storedLopAmount,
        requestedDays: days,
        alreadyReversedDays: facts.alreadyReversedDays,
      })
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plan?.ok) return;
    setBusy(true);
    const res = await reverseLwpDays({ payslipId, days, payoutPeriod, note: note.trim() });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`LWP reversal queued — $${res.data.credit.toLocaleString("en-NZ")} onto the ${payoutPeriod} run.`);
    await onReversed();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reverse LWP days"
      description="Refund loss-of-pay days docked on a PAID slip, at the slip's own stored per-day dock price. The refund lands as an adjustment on the chosen payout run."
    >
      {!facts ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin" /> Reading the paid slip…
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3" data-testid="lwp-correction-form">
          <div className="text-sm">
            <div className="font-medium text-foreground">
              {facts.userName} · {facts.slipNo} ({facts.period})
            </div>
            <div className="text-muted-foreground mt-1">
              {facts.storedLopDays} day(s) docked · ${facts.storedLopAmount.toLocaleString("en-NZ")} LOP line · ${facts.perDay.toLocaleString("en-NZ")}/day
            </div>
            <div className="text-muted-foreground text-[0.8125rem] mt-0.5">
              {facts.alreadyReversedDays > 0
                ? `${facts.alreadyReversedDays} day(s) already reversed — ${facts.reversibleDays} still reversible`
                : `${facts.reversibleDays} day(s) reversible`}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Days to reverse">
              <input
                type="number" min={0.25} max={facts.reversibleDays} step={0.25}
                className="f-input" value={daysStr}
                onChange={(e) => setDaysStr(e.target.value)}
                placeholder="1" data-testid="lwp-days"
              />
            </Field>
            <Field label="Payout period">
              <input
                type="month" className="f-input" value={payoutPeriod}
                onChange={(e) => setPayoutPeriod(e.target.value)} data-testid="lwp-payout-period"
              />
            </Field>
          </div>
          <Field label="Reason (optional)">
            <input className="f-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder="e.g. Attendance was corrected after the run locked" />
          </Field>
          {plan && !plan.ok && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600" data-testid="lwp-plan-error">
              {plan.reason}
            </div>
          )}
          {plan?.ok && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="lwp-plan-ok">
              Refund ${plan.credit.toLocaleString("en-NZ")} ({plan.days} day(s) × ${plan.perDay.toLocaleString("en-NZ")}/day) onto the {payoutPeriod} run.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy || !plan?.ok} data-testid="lwp-submit">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />} Reverse days
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
