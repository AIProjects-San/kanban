"use client";

// ---------------------------------------------------------------------------
// G3 — the loan detail: the amortization schedule table ( installment no,
// due date, principal/interest split, status, the paying payslip), the
// repayment history, and the early-repayment / final-settlement action.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Coins, HandCoins } from "lucide-react";
import { earlyRepayLoan } from "@/server-actions/loans";
import type { LoanDetailT } from "@/lib/types";

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

const SCHEDULE_BADGE: Record<string, string> = {
  SCHEDULED: "bg-muted text-muted-foreground",
  PAID: "bg-emerald-500/10 text-emerald-600",
  SKIPPED: "bg-amber-500/10 text-amber-600",
  WRITTEN_OFF: "bg-zinc-500/10 text-zinc-600",
};

const SOURCE_LABEL: Record<string, string> = {
  PAYROLL: "Payroll deduction",
  MANUAL: "Manual / early",
  FINAL_SETTLEMENT: "Final settlement",
};

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LoanDetailView({ loan }: { loan: LoanDetailT }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [repayOpen, setRepayOpen] = useState(false);
  const [interestAdjustment, setInterestAdjustment] = useState("0");
  const [source, setSource] = useState<"MANUAL" | "FINAL_SETTLEMENT">("MANUAL");
  const [note, setNote] = useState("");

  const paidTotal = loan.repayments.reduce((s, r) => s + r.amount, 0);

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
          <Link
            href={`/admin/employees/${loan.employeeId}/loans`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All loans — {loan.employeeName}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Coins className="h-6 w-6 text-primary" />
            {loan.typeName} loan — {fmtMoney(loan.principal)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {(loan.interestRate * 100).toFixed(2)}% p.a. (reducing balance) · {loan.termMonths} months ·
            started {loan.startDay} · {loan.summary}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[loan.status] ?? ""}`}>
            {loan.status.replace("_", " ").toLowerCase()}
          </span>
          {loan.status === "ACTIVE" && loan.outstandingBalance > 0 && (
            <button
              type="button"
              onClick={() => setRepayOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <HandCoins className="h-4 w-4" /> Repay early
            </button>
          )}
        </div>
      </div>

      {/* Schedule */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Amortization schedule</h2>
          <p className="text-xs text-muted-foreground">
            One deduction per installment rides the payroll adjustment adapter;
            the row flips Paid when its consuming run is settled.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="px-4 py-3 font-medium">Principal</th>
              <th className="px-4 py-3 font-medium">Interest</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Payslip</th>
            </tr>
          </thead>
          <tbody>
            {loan.schedule.map((s) => (
              <tr key={s.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2.5 text-muted-foreground">{s.installmentNo}</td>
                <td className="px-4 py-2.5">{s.dueDay}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmtMoney(s.principalPortion)}</td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{fmtMoney(s.interestPortion)}</td>
                <td className="px-4 py-2.5 tabular-nums font-medium">{fmtMoney(s.totalAmount)}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SCHEDULE_BADGE[s.status] ?? ""}`}>
                    {s.status === "WRITTEN_OFF" ? "written off" : s.status.toLowerCase()}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.payslipId ?? "—"}</td>
              </tr>
            ))}
            {loan.schedule.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No schedule yet — the schedule is written when the loan is activated.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Repayments */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Repayment history</h2>
            <p className="text-xs text-muted-foreground">
              {loan.repayments.length} event{loan.repayments.length === 1 ? "" : "s"} · {fmtMoney(paidTotal)} repaid to date
            </p>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Paid at</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Principal</th>
              <th className="px-4 py-3 font-medium">Interest</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {loan.repayments.map((r) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2.5">{r.paidAt.slice(0, 10)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{SOURCE_LABEL[r.source] ?? r.source}</td>
                <td className="px-4 py-2.5 tabular-nums">{fmtMoney(r.principalPaid)}</td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{fmtMoney(r.interestPaid)}</td>
                <td className="px-4 py-2.5 tabular-nums font-medium">{fmtMoney(r.amount)}</td>
                <td className="max-w-xs truncate px-4 py-2.5 text-xs text-muted-foreground" title={r.note}>{r.note}</td>
              </tr>
            ))}
            {loan.repayments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No repayments recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Early repayment modal */}
      {repayOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Repay the loan in full</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pays the outstanding <strong>{fmtMoney(loan.outstandingBalance)}</strong> principal
              {loan.schedule.filter((s) => s.status === "SCHEDULED").length > 0 && (
                <>
                  {" "}and closes out {loan.schedule.filter((s) => s.status === "SCHEDULED").length} remaining
                  installment{loan.schedule.filter((s) => s.status === "SCHEDULED").length === 1 ? "" : "s"}
                </>
              )}
              . Future payroll deductions are neutralized (skipped, with a visible reason).
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="repay-interest">Interest adjustment (NZ$ — the waived future interest)</label>
                <input id="repay-interest" className={inputCls} type="number" min="0" step="0.01" value={interestAdjustment} onChange={(e) => setInterestAdjustment(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="repay-source">Source</label>
                <select id="repay-source" className={inputCls} value={source} onChange={(e) => setSource(e.target.value as "MANUAL" | "FINAL_SETTLEMENT")}>
                  <option value="MANUAL">Manual / direct payment</option>
                  <option value="FINAL_SETTLEMENT">Final settlement — deduct from FnF dues</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="repay-note">Note</label>
                <input id="repay-note" className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, audited" />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setRepayOpen(false)}>Back</button>
              <button
                type="button"
                disabled={pending}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() =>
                  run(async () => {
                    const res = await earlyRepayLoan({
                      loanId: loan.id,
                      interestAdjustment: Number(interestAdjustment || 0),
                      source,
                      note,
                    });
                    if (res.ok) setRepayOpen(false);
                    return res;
                  }, "Loan repaid in full")
                }
              >
                Repay {fmtMoney(loan.outstandingBalance + Number(interestAdjustment || 0))}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
