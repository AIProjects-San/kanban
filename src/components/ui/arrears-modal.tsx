"use client";

// P3 (PR-13/PR-B11, F3.1) — the arrears modal: preview the reverse-simulation
// (nothing written), then emit the positive deltas as ARREARS adjustments
// on the chosen payout period. Toy-scale, honestly labeled — the modal says
// what the simulation does and does not re-derive.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { ArrearsPreviewT } from "@/lib/types";
import { previewArrearsRun, generateArrears } from "@/server-actions/payroll-arrears";
import { currentPeriod } from "@/lib/payroll/payroll-math";

export function ArrearsModal({
  open,
  onClose,
  runId,
  runPeriod,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  runId: string;
  runPeriod: string;
  onGenerated: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<ArrearsPreviewT[]>([]);
  const [payoutPeriod, setPayoutPeriod] = useState(currentPeriod());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await previewArrearsRun({ runId });
    if (res.ok) setRows(res.data);
    else toast.error(res.error);
    setLoaded(true);
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setLoaded(false); setRows([]); void load(); }
  }, [open, load]);

  const owed = rows.filter((r) => r.owed && !r.alreadyArranged);
  const arranged = rows.filter((r) => r.alreadyArranged);
  const totalOwed = Math.round(owed.reduce((s, r) => s + r.delta, 0) * 100) / 100;

  const generate = async () => {
    setBusy(true);
    const res = await generateArrears({ runId, payoutPeriod });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(
      res.data.created > 0
        ? `Arrears arranged — ${res.data.created} adjustment(s), $${res.data.totalDelta.toLocaleString("en-NZ")} onto the ${payoutPeriod} run.`
        : "No arrears owed under the current structures.",
    );
    await onGenerated();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Arrears — ${runPeriod}`}
      size="lg"
      description="Re-simulates every slip in this paid run under the employees' CURRENT active structures (stored payment windows and LOP days replayed as-is). Positive differences only — overpayment recovery is a separate, deliberate correction."
    >
      <div className="space-y-4">
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Re-simulating the paid slips…
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="px-3 py-2 font-semibold">Employee</th>
                    <th className="px-3 py-2 font-semibold">Paid</th>
                    <th className="px-3 py-2 font-semibold">Should pay</th>
                    <th className="px-3 py-2 font-semibold">Arrears</th>
                    <th className="px-3 py-2 font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.payslipId} className="border-b border-border last:border-0" data-testid="arrears-row">
                      <td className="px-3 py-2">
                        <span className="font-medium">{r.userName}</span>
                        <span className="block text-[0.6875rem] text-muted-foreground font-mono">{r.slipNo}</span>
                      </td>
                      <td className="px-3 py-2 tabular-nums">${r.storedNet.toLocaleString("en-NZ")}</td>
                      <td className="px-3 py-2 tabular-nums">${r.simulatedNet.toLocaleString("en-NZ")}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {r.alreadyArranged
                          ? <span className="text-[0.6875rem] text-muted-foreground">already arranged</span>
                          : r.owed
                            ? <span className="font-semibold text-emerald-600">+${r.delta.toLocaleString("en-NZ")}</span>
                            : <span className="text-[0.6875rem] text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-[0.6875rem] text-muted-foreground max-w-40 truncate" title={r.reason}>
                        {r.reason}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-sm text-muted-foreground text-center">No payslips in this run.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {owed.length > 0 ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field label={`Payout period (${owed.length} employee(s), $${totalOwed.toLocaleString("en-NZ")})`}>
                  <input
                    type="month"
                    className="f-input"
                    value={payoutPeriod}
                    onChange={(e) => setPayoutPeriod(e.target.value)}
                    data-testid="arrears-payout-period"
                  />
                </Field>
                <button
                  className="f-btn f-btn-primary"
                  disabled={busy || !payoutPeriod}
                  onClick={() => void generate()}
                  data-testid="arrears-generate-btn"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} Arrange arrears
                </button>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {arranged.length > 0
                  ? "Every owed slip in this run already has arrears arranged."
                  : "No arrears owed — every slip paid at least what the current structures would pay."}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
