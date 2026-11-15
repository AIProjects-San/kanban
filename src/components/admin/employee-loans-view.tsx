"use client";

// ---------------------------------------------------------------------------
// G3 — the employee's loans surface: the list with its lifecycle actions
// (submit / approve / reject / cancel / activate) and the create modal
// (type-driven caps; the rate is snapshotted server-side). The schedule
// and repayment history live on the detail page.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Coins, Plus, Send, X, Zap } from "lucide-react";
import {
  createLoan,
  submitLoan,
  approveLoan,
  rejectLoan,
  cancelLoan,
  activateLoan,
} from "@/server-actions/loans";
import type { LoanT, LoanTypeT } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  PENDING_APPROVAL: "bg-amber-500/10 text-amber-600",
  APPROVED: "bg-blue-500/10 text-blue-600",
  ACTIVE: "bg-emerald-500/10 text-emerald-600",
  CLOSED: "bg-sky-500/10 text-sky-600",
  REJECTED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  ACTIVE: "Active",
  CLOSED: "Closed (repaid)",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtRate(rate: number): string {
  return rate === 0 ? "interest-free" : `${(rate * 100).toFixed(2)}% p.a.`;
}

function nextMonth(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

export function EmployeeLoansView({
  employee,
  loans,
  types,
}: {
  employee: { id: string; name: string; email: string };
  loans: LoanT[];
  types: LoanTypeT[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<LoanT | null>(null);
  const [cancelNote, setCancelNote] = useState("");

  // The create form.
  const [loanTypeId, setLoanTypeId] = useState(types[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [termMonths, setTermMonths] = useState("12");
  const [startDate, setStartDate] = useState(nextMonth());
  const [reason, setReason] = useState("");

  const activeTypes = types.filter((t) => t.isActive);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Loans — {employee.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Approval-gated, amortized loans. Activation writes the installment
            schedule and the payroll deduction rows; repayments land as each
            run locks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={activeTypes.length === 0}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> New loan
        </button>
      </div>

      {activeTypes.length === 0 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          No active loan types exist yet — create one under Payroll → Loans
          before drafting a loan.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Principal</th>
              <th className="px-4 py-3 font-medium">Rate</th>
              <th className="px-4 py-3 font-medium">Term</th>
              <th className="px-4 py-3 font-medium">Outstanding</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loans.map((l) => (
              <tr key={l.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{l.typeName}</td>
                <td className="px-4 py-3 tabular-nums">{fmtMoney(l.principal)}</td>
                <td className="px-4 py-3 text-muted-foreground">{fmtRate(l.interestRate)}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.termMonths} mo</td>
                <td className="px-4 py-3 tabular-nums font-medium">{fmtMoney(l.outstandingBalance)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[l.status] ?? ""}`}>
                    {STATUS_LABEL[l.status] ?? l.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      href={`/admin/employees/${l.employeeId}/loans/${l.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      <Coins className="h-3.5 w-3.5" /> Schedule
                    </Link>
                    {l.status === "DRAFT" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => submitLoan({ loanId: l.id }), "Loan submitted for approval")}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Send className="h-3 w-3" /> Submit
                      </button>
                    )}
                    {l.status === "PENDING_APPROVAL" && (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => approveLoan({ loanId: l.id }), "Loan approved")}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10"
                        >
                          <Check className="h-3 w-3" /> Approve
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => rejectLoan({ loanId: l.id }), "Loan rejected")}
                          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          <X className="h-3 w-3" /> Reject
                        </button>
                      </>
                    )}
                    {l.status === "APPROVED" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => activateLoan({ loanId: l.id }), "Loan activated — schedule written")}
                        className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-500/10"
                      >
                        <Zap className="h-3 w-3" /> Activate
                      </button>
                    )}
                    {["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(l.status) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => { setConfirmCancel(l); setCancelNote(""); }}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                      >
                        <X className="h-3 w-3" /> Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {loans.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No loans for this employee yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">New loan — {employee.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Four-eyes applies: the approver must be someone other than the
              creator (and the employee). The interest rate is snapshotted
              from the type at creation.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="loan-type">Loan type</label>
                <select id="loan-type" className={inputCls} value={loanTypeId} onChange={(e) => setLoanTypeId(e.target.value)}>
                  {activeTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {fmtRate(t.interestRate)}
                      {t.maxAmount != null ? ` (max ${fmtMoney(t.maxAmount)})` : ""}
                      {t.maxTermMonths != null ? ` (≤ ${t.maxTermMonths} mo)` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="loan-principal">Principal (NZ$)</label>
                  <input id="loan-principal" className={inputCls} type="number" min="0.01" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="5000.00" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="loan-term">Term (months)</label>
                  <input id="loan-term" className={inputCls} type="number" min="1" max="360" step="1" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="loan-start">Start date (first installment due +1 month)</label>
                <input id="loan-start" className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="loan-reason">Reason</label>
                <input id="loan-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Housing support — staff assistance scheme" />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setOpen(false)}>Cancel</button>
              <button
                type="button"
                disabled={pending || !loanTypeId || !principal}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={() =>
                  run(async () => {
                    const res = await createLoan({
                      employeeId: employee.id,
                      loanTypeId,
                      principal: Number(principal),
                      termMonths: Number(termMonths),
                      startDate,
                      reason,
                    });
                    if (res.ok) setOpen(false);
                    return res;
                  }, "Loan drafted")
                }
              >
                Draft loan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirm */}
      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Cancel this loan?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {confirmCancel.typeName} — {fmtMoney(confirmCancel.principal)} over {confirmCancel.termMonths} months.
              Only drafts, pending and approved loans can be cancelled.
            </p>
            <input
              className={`${inputCls} mt-3`}
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
              placeholder="Reason (optional, audited)"
              aria-label="Cancellation reason"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setConfirmCancel(null)}>Keep it</button>
              <button
                type="button"
                disabled={pending}
                className="h-9 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
                onClick={() =>
                  run(async () => {
                    const res = await cancelLoan({ loanId: confirmCancel.id, note: cancelNote });
                    if (res.ok) setConfirmCancel(null);
                    return res;
                  }, "Loan cancelled")
                }
              >
                Cancel loan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
