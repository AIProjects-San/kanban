"use client";

// ---------------------------------------------------------------------------
// G3 — the payroll-admin loans overview (/admin/payroll/loans): the loan
// type catalog (workspace-level), every ACTIVE loan with the installment
// due in the selected period, and the per-employee drill-in.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, Coins, Pencil, Plus } from "lucide-react";
import { createLoanType, updateLoanType } from "@/server-actions/loans";
import type { LoansOverviewT, LoanTypeT } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtRate(rate: number): string {
  return rate === 0 ? "interest-free" : `${(rate * 100).toFixed(2)}% p.a.`;
}

export function LoansOverviewView({ data }: { data: LoansOverviewT }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [period, setPeriod] = useState(data.periodKey);
  const [typeModal, setTypeModal] = useState<"create" | LoanTypeT | null>(null);

  // The type edit form.
  const [typeName, setTypeName] = useState("");
  const [typeRate, setTypeRate] = useState("0");
  const [typeMax, setTypeMax] = useState("");
  const [typeMaxTerm, setTypeMaxTerm] = useState("");
  const [typeActive, setTypeActive] = useState(true);

  function openTypeModal(t: "create" | LoanTypeT) {
    setTypeModal(t);
    if (t === "create") {
      setTypeName(""); setTypeRate("0"); setTypeMax(""); setTypeMaxTerm(""); setTypeActive(true);
    } else {
      setTypeName(t.name);
      setTypeRate(String(t.interestRate));
      setTypeMax(t.maxAmount != null ? String(t.maxAmount) : "");
      setTypeMaxTerm(t.maxTermMonths != null ? String(t.maxTermMonths) : "");
      setTypeActive(t.isActive);
    }
  }

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
          <h1 className="text-2xl font-semibold tracking-tight">Loans</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every active loan with its live outstanding, the installment due in
            the chosen period, and the workspace&apos;s loan type catalog.
            Installment deductions ride the payroll adjustment adapter — the
            consuming run carries the money.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openTypeModal("create")}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New loan type
        </button>
      </div>

      {/* Active loans */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">
            Active loans
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {data.loans.length} loan{data.loans.length === 1 ? "" : "s"} · sorted by outstanding
            </span>
          </h2>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              router.push(`/admin/payroll/loans?period=${period}`);
            }}
          >
            <label className="text-xs text-muted-foreground" htmlFor="loans-period">Due in period</label>
            <input
              id="loans-period"
              className="h-8 w-28 rounded-md border border-input bg-transparent px-2 text-sm"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              onBlur={() => router.push(`/admin/payroll/loans?period=${period}`)}
            />
          </form>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Employee</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Principal</th>
              <th className="px-4 py-3 font-medium">Outstanding</th>
              <th className="px-4 py-3 font-medium">Due in {data.periodKey}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data.loans.map((l) => (
              <tr key={l.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{l.employeeName}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.typeName}</td>
                <td className="px-4 py-3 tabular-nums">{fmtMoney(l.principal)}</td>
                <td className="px-4 py-3 tabular-nums font-medium">{fmtMoney(l.outstandingBalance)}</td>
                <td className="px-4 py-3">
                  {l.dueThisPeriod ? (
                    <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
                      <CalendarClock className="h-3.5 w-3.5 text-emerald-600" />
                      #{l.dueThisPeriod.installmentNo} · {fmtMoney(l.dueThisPeriod.totalAmount)} ({l.dueThisPeriod.dueDay})
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/admin/employees/${l.employeeId}/loans/${l.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    <Coins className="h-3.5 w-3.5" /> Detail
                  </Link>
                </td>
              </tr>
            ))}
            {data.loans.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No active loans. Draft one from an employee&apos;s loans page.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Loan types */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Loan type catalog</h2>
          <p className="text-xs text-muted-foreground">
            The rate a loan snapshots at creation; the caps apply to new loans only.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Interest rate</th>
              <th className="px-4 py-3 font-medium">Max amount</th>
              <th className="px-4 py-3 font-medium">Max term</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data.types.map((t) => (
              <tr key={t.id} className={`border-b border-border/60 last:border-0 hover:bg-muted/30 ${t.isActive ? "" : "opacity-60"}`}>
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{fmtRate(t.interestRate)}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.maxAmount != null ? fmtMoney(t.maxAmount) : "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.maxTermMonths != null ? `${t.maxTermMonths} mo` : "—"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${t.isActive ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                    {t.isActive ? "active" : "inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => openTypeModal(t)}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                </td>
              </tr>
            ))}
            {data.types.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No loan types yet — create the first (e.g. Housing, Vehicle, Emergency).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Type create/edit modal */}
      {typeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">{typeModal === "create" ? "New loan type" : `Edit — ${typeModal.name}`}</h2>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="lt-name">Name</label>
                <input id="lt-name" className={inputCls} value={typeName} onChange={(e) => setTypeName(e.target.value)} placeholder="Housing" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="lt-rate">Annual interest rate (fraction — 0.05 = 5% p.a., 0 = interest-free)</label>
                <input id="lt-rate" className={inputCls} type="number" min="0" max="1" step="0.0001" value={typeRate} onChange={(e) => setTypeRate(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="lt-max">Max amount (NZ$)</label>
                  <input id="lt-max" className={inputCls} type="number" min="0.01" step="0.01" value={typeMax} onChange={(e) => setTypeMax(e.target.value)} placeholder="uncapped" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="lt-term">Max term (months)</label>
                  <input id="lt-term" className={inputCls} type="number" min="1" max="360" step="1" value={typeMaxTerm} onChange={(e) => setTypeMaxTerm(e.target.value)} placeholder="uncapped" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={typeActive} onChange={(e) => setTypeActive(e.target.checked)} />
                Active (selectable for new loans)
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setTypeModal(null)}>Cancel</button>
              <button
                type="button"
                disabled={pending || !typeName}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={() =>
                  run(async () => {
                    const payload = {
                      name: typeName,
                      interestRate: Number(typeRate || 0),
                      maxAmount: typeMax === "" ? null : Number(typeMax),
                      maxTermMonths: typeMaxTerm === "" ? null : Number(typeMaxTerm),
                      isActive: typeActive,
                    };
                    const res = typeModal === "create"
                      ? await createLoanType(payload)
                      : await updateLoanType({ ...(typeModal as LoanTypeT), ...payload });
                    if (res.ok) setTypeModal(null);
                    return res;
                  }, typeModal === "create" ? "Loan type created" : "Loan type updated")
                }
              >
                {typeModal === "create" ? "Create type" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
