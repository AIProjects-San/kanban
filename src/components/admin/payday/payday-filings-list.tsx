"use client";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the EI filings list: payDate, period, due
// date, status, totals, days overdue; status filter + overdue tab.
// ---------------------------------------------------------------------------

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, FileText, Loader2, RefreshCw } from "lucide-react";
import { refreshOverdueFilings } from "@/server-actions/payday-filing";
import type { PaydayFilingSummaryT } from "@/lib/ird/filing-types";
import { formatMoneyCents } from "@/lib/shared/format";
import { FILING_STATUS_BADGE, FILING_STATUSES } from "@/lib/shared/config";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function PaydayFilingsList({
  filings,
  statusFilter,
  overdueOnly,
}: {
  filings: PaydayFilingSummaryT[];
  statusFilter: string;
  overdueOnly: boolean;
}) {
  const router = useRouter();

  const setFilter = (status: string, overdue: boolean) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (overdue) params.set("overdue", "1");
    router.push(`/admin/payroll/filings${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const refresh = async () => {
    const res = await refreshOverdueFilings();
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(res.data.flagged > 0 ? `${res.data.flagged} filing(s) newly flagged overdue.` : "No new overdue filings.");
    router.refresh();
  };

  return (
    <div className="space-y-4" data-testid="payday-filings-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <FileText size={20} /> Employment Information filings
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            One EI return per payday · due 2 working days after each payday · Fernly builds the file, you upload it to myIR.
          </p>
        </div>
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          onClick={() => void refresh()}
          data-testid="refresh-overdue-btn"
        >
          <RefreshCw size={14} /> Refresh overdue flags
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={`rounded-md px-3 py-1.5 text-sm ${!overdueOnly && statusFilter === "" ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
          onClick={() => setFilter("", false)}
        >
          All ({filings.length})
        </button>
        {FILING_STATUSES.map((s) => (
          <button
            key={s}
            className={`rounded-md px-3 py-1.5 text-sm ${!overdueOnly && statusFilter === s ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
            onClick={() => setFilter(s, false)}
          >
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
        <button
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${overdueOnly ? "bg-red-600 text-white" : "border border-red-500/40 text-red-700 hover:bg-red-500/10"}`}
          onClick={() => setFilter("", true)}
          data-testid="overdue-tab"
        >
          <AlertTriangle size={13} /> Overdue
        </button>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-x-auto" data-testid="filings-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground bg-muted/40">
              <th className="px-3 py-2 font-medium">Payday</th>
              <th className="px-3 py-2 font-medium">Period(s)</th>
              <th className="px-3 py-2 font-medium">Cycle</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Lines</th>
              <th className="px-3 py-2 font-medium text-right">Gross</th>
              <th className="px-3 py-2 font-medium text-right">PAYE</th>
              <th className="px-3 py-2 font-medium text-right">Days overdue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filings.map((f) => (
              <tr key={f.id} className="hover:bg-muted/40">
                <td className="px-3 py-2 font-medium">{day(f.payDate)}</td>
                <td className="px-3 py-2 text-muted-foreground">{f.runPeriods.join(", ") || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{f.payCycle}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1"><CalendarClock size={12} className="text-muted-foreground" />{day(f.dueDate)}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-[0.625rem] font-semibold px-1.5 py-0.5 rounded ${FILING_STATUS_BADGE[f.status] ?? FILING_STATUS_BADGE.DRAFT}`}>{f.status}</span>
                </td>
                <td className="px-3 py-2 text-right">{f.totalEmployeeLines}</td>
                <td className="px-3 py-2 text-right font-mono">{formatMoneyCents(f.totalGrossCents)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatMoneyCents(f.totalPayeCents)}</td>
                <td className={`px-3 py-2 text-right ${f.workingDaysRemaining < 0 && f.status !== "ACCEPTED" && f.status !== "AMENDED" ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                  {f.workingDaysRemaining < 0 && f.status !== "ACCEPTED" && f.status !== "AMENDED"
                    ? `${Math.abs(f.workingDaysRemaining)}`
                    : "—"}
                </td>
              </tr>
            ))}
            {filings.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  No Employment Information filings yet — open a locked run&apos;s filing panel to generate the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Generate a filing from a run&apos;s filing panel (Payroll → a locked run → Filing). <Loader2 size={11} className="inline" /> nothing here uploads automatically.
      </p>
    </div>
  );
}
