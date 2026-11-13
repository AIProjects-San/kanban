"use client";

// P8 (PR-19/PR-B13, F3.3) — the salary-withholding modal: the hold list
// (live hold balance per row), the hold creator (window + reason), and the
// release form (payout month — the held nets pay as WITHHELD_RELEASE
// adjustment lines on that run). The state machine is visible end to end:
// ACTIVE → RELEASED is terminal; WITHHELD slips are named, never hidden.

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import {
  listSalaryWithholdings,
  createSalaryWithholding,
  releaseSalaryWithholding,
} from "@/server-actions/payroll-withholding";
import { currentPeriod } from "@/lib/payroll-math";
import type { SalaryWithholdingT } from "@/lib/types";
import { formatMoney } from "@/lib/format";

export function WithholdingModal({
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
  const [rows, setRows] = useState<SalaryWithholdingT[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hold creator state.
  const [userId, setUserId] = useState(employees[0]?.userId ?? "");
  const [fromPeriod, setFromPeriod] = useState(currentPeriod());
  const [untilPeriod, setUntilPeriod] = useState("");
  const [reason, setReason] = useState("");

  // Release state: which row's release form is open.
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releasePeriod, setReleasePeriod] = useState(currentPeriod());

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSalaryWithholdings();
    setLoading(false);
    if (!res.ok) { toast.error(res.error); return; }
    setRows(res.data);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setReleasingId(null); }
  }, [open, load]);

  const submitHold = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await createSalaryWithholding({
      userId,
      fromPeriod,
      untilPeriod: untilPeriod.trim() === "" ? null : untilPeriod,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Hold created — payslips from ${fromPeriod} are computed but not paid until released.`);
    setReason("");
    setUntilPeriod("");
    await load();
    onChanged();
  };

  const submitRelease = async (id: string) => {
    setBusy(true);
    const res = await releaseSalaryWithholding({ withholdingId: id, releasePeriod, note: "" });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(
      `Released — ${res.data.adjustmentCount} held payslip(s) totalling ${formatMoney(res.data.total)} pay on the ${releasePeriod} run.`,
    );
    setReleasingId(null);
    await load();
    onChanged();
  };

  return (
    <Modal open={open} onClose={onClose} title="Salary withholding"
      description="Hold an employee's salary over a window — slips inside it are computed but not paid until released; releasing pays the held nets through the adjustments adapter.">
      <div className="space-y-3" data-testid="withholding-panel">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" /> Loading holds…
          </div>
        ) : (
          <>
            {/* The hold list */}
            <div className="rounded-md border border-border divide-y divide-border" data-testid="withholding-list">
              {rows.map((r) => (
                <div key={r.id} className="px-3 py-2.5 text-sm" data-testid={`withholding-row-${r.status.toLowerCase()}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn(
                      "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                      r.status === "ACTIVE" ? "bg-orange-500/10 text-orange-600" : "bg-emerald-500/10 text-emerald-600",
                    )}>
                      {r.status === "ACTIVE" ? "HOLDING" : "RELEASED"}
                    </span>
                    <span className="font-medium">{r.userName}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.fromPeriod} → {r.untilPeriod ?? "open-ended"}
                    </span>
                    {r.status === "ACTIVE" ? (
                      <span className="text-xs text-muted-foreground ml-auto">
                        held: {r.heldSlipCount} slip(s) · {formatMoney(r.heldTotal)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground ml-auto">
                        paid on the {r.releasePeriod} run
                      </span>
                    )}
                  </div>
                  {r.reason && <div className="text-xs text-muted-foreground mt-1">{r.reason}</div>}
                  {r.status === "ACTIVE" && (
                    <div className="mt-2">
                      {releasingId === r.id ? (
                        <FormRow>
                          <Field label="Release payout month">
                            <input className="f-input" type="month" value={releasePeriod}
                              onChange={(e) => setReleasePeriod(e.target.value)}
                              data-testid="withholding-release-period" />
                          </Field>
                          <div className="flex items-end gap-2">
                            <button type="button" className="f-btn f-btn-primary text-xs"
                              disabled={busy || r.heldSlipCount === 0}
                              onClick={() => void submitRelease(r.id)}
                              data-testid="withholding-release-confirm">
                              <PlayCircle size={13} /> Release {formatMoney(r.heldTotal)}
                            </button>
                            <button type="button" className="f-btn f-btn-ghost text-xs"
                              onClick={() => setReleasingId(null)}>
                              Cancel
                            </button>
                          </div>
                        </FormRow>
                      ) : (
                        <button type="button" className="f-btn f-btn-ghost text-xs"
                          onClick={() => { setReleasingId(r.id); setReleasePeriod(currentPeriod()); }}
                          data-testid={`withholding-release-btn`}>
                          <PlayCircle size={13} /> Release hold
                        </button>
                      )}
                      {r.heldSlipCount === 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          No payslips held yet — slips created inside the window land here.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {rows.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No holds — create one to stop an employee&apos;s salary over a window.
                </div>
              )}
            </div>

            {/* The hold creator */}
            <form onSubmit={submitHold} className="rounded-md border border-border p-3 space-y-2" data-testid="withholding-form">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Clock size={13} /> New hold
              </div>
              <FormRow>
                <Field label="Employee">
                  <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)}
                    data-testid="withholding-user">
                    {employees.map((emp) => <option key={emp.userId} value={emp.userId}>{emp.name}</option>)}
                  </select>
                </Field>
                <Field label="Hold from (month)">
                  <input className="f-input" type="month" value={fromPeriod}
                    onChange={(e) => setFromPeriod(e.target.value)}
                    data-testid="withholding-from" />
                </Field>
                <Field label="Hold until (optional)">
                  <input className="f-input" type="month" value={untilPeriod}
                    onChange={(e) => setUntilPeriod(e.target.value)}
                    data-testid="withholding-until" />
                </Field>
              </FormRow>
              <Field label="Reason (optional)">
                <input className="f-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                  placeholder="e.g. Pending dispute resolution" />
              </Field>
              <div className="flex justify-end">
                <button type="submit" className="f-btn f-btn-primary" disabled={busy || !userId || !fromPeriod}
                  data-testid="withholding-submit">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Clock size={15} />} Hold salary
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </Modal>
  );
}
