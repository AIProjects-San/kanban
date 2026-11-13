"use client";

// ---------------------------------------------------------------------------
// Phase 1C (G2) — the trial balance view: period filter, one row per
// account (opening / debits / credits / closing), the totals row, CSV
// export, and the period-close control (with the reversal discipline
// spelled out).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Lock, Scale } from "lucide-react";
import {
  closePeriod,
  exportTrialBalanceCsv,
} from "@/server-actions/accounting";
import type { TrialBalanceT } from "@/server-actions/accounting";
import { formatMoney, downloadBlob } from "@/lib/format";

interface PeriodT {
  id: string;
  startDate: string;
  endDate: string;
  isClosed: boolean;
  entryCount: number;
}

const TYPE_LABELS: Record<string, string> = {
  ASSET: "Asset",
  LIABILITY: "Liability",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expense",
};

export function TrialBalanceView({
  periods,
  selectedId,
  balance,
}: {
  periods: PeriodT[];
  selectedId: string;
  balance: TrialBalanceT;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  function switchPeriod(id: string) {
    router.push(`/accounting/trial-balance?period=${id}`);
  }

  function exportCsv() {
    setBusy(true);
    startTransition(async () => {
      const res = await exportTrialBalanceCsv(selectedId);
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      downloadBlob(res.data.csv, res.data.filename, res.data.mime);
    });
  }

  function close() {
    startTransition(async () => {
      const res = await closePeriod(selectedId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Period closed — future postings are refused; corrections must be reversal entries in an open period.");
      router.refresh();
    });
  }

  const balanced =
    Math.abs(balance.totals.debits - balance.totals.credits) < 0.005 &&
    Math.abs(balance.totals.opening) < 0.005;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Scale className="h-5 w-5" /> Trial balance
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One row per account with the opening balance (from prior
            periods), this period&apos;s debits and credits, and the closing
            balance. Payroll runs post their statutory liabilities and net
            pay clearing here when they lock.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedId}
            onChange={(e) => switchPeriod(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm"
            aria-label="Accounting period"
          >
            {periods.slice(0, 24).map((p) => (
              <option key={p.id} value={p.id}>
                {p.startDate.slice(0, 7)} · {p.entryCount} entr{p.entryCount === 1 ? "y" : "ies"}
                {p.isClosed ? " · closed" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={busy || pending}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> CSV
          </button>
          {!balance.period.isClosed && (
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Lock className="h-4 w-4" /> Close period
            </button>
          )}
        </div>
      </div>

      <p
        className={`rounded-lg border px-4 py-3 text-sm ${
          balanced
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
            : "border-destructive/40 bg-destructive/10 text-destructive"
        }`}
      >
        {balanced ? "In balance —" : "OUT OF BALANCE —"} total debits{" "}
        {formatMoney(balance.totals.debits)} vs total credits{" "}
        {formatMoney(balance.totals.credits)}
        {balanced ? " ; opening balances net to zero." : "."}
      </p>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Opening</th>
              <th className="px-4 py-3 text-right font-medium">Debits</th>
              <th className="px-4 py-3 text-right font-medium">Credits</th>
              <th className="px-4 py-3 text-right font-medium">Closing</th>
            </tr>
          </thead>
          <tbody>
            {balance.rows.map((r) => (
              <tr key={r.code} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2.5 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-2.5">{r.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {TYPE_LABELS[r.type] ?? r.type}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {r.opening ? formatMoney(r.opening) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {r.debits ? formatMoney(r.debits) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {r.credits ? formatMoney(r.credits) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                  {r.closing ? formatMoney(r.closing) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/40 font-medium">
              <td className="px-4 py-3" colSpan={3}>
                TOTALS
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(balance.totals.opening)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(balance.totals.debits)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(balance.totals.credits)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(balance.totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
