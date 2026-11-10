"use client";

// P21 (LV-R01) — HR console tab: the employee leave balance report
// (benchmark: hrms "Employee Leave Balance" report). One row per
// (leave type × member) for the chosen year — opening balance, allocated,
// taken, expired, closing — aggregated from the append-only leave ledger
// (the source of truth; the LeaveBalance cache is never read). Zero pairs
// are skipped, matching the benchmark. CSV export rides the P20 payroll-csv
// discipline (RFC 4180 + disclaimer + audit).

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Download, Loader2, Scale } from "lucide-react";
import { toast } from "sonner";
import type { LeaveTypeT } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getLeaveBalanceReport, exportLeaveBalanceReportCsv } from "@/server-actions/hr-leave";
import type { LeaveBalanceReportRow } from "@/lib/leave-balance-report";

function fmtDays(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

export function BalancesTab({ types }: { types: LeaveTypeT[] }) {
  const year = new Date().getUTCFullYear();
  const [reportYear, setReportYear] = useState<number>(year);
  const [rows, setRows] = useState<LeaveBalanceReportRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");

  const load = useCallback(async (y: number) => {
    const res = await getLeaveBalanceReport({ year: y });
    if (res.ok) {
      setRows(res.data.rows);
    } else {
      toast.error(res.error);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(reportYear); }, [load, reportYear]);

  const typeNameById = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter !== "ALL" && r.leaveTypeId !== typeFilter) return false;
      if (!q) return true;
      return (
        r.userName.toLowerCase().includes(q) ||
        (r.employeeNumber ?? "").toLowerCase().includes(q) ||
        r.leaveTypeName.toLowerCase().includes(q)
      );
    });
  }, [rows, typeFilter, search]);

  // P21 (LV-R01) — the CSV download (the analytics Blob pattern; the action
  // builds the RFC 4180 file and audits the export like the payroll CSVs).
  const exportCsv = async () => {
    setBusy(true);
    const res = await exportLeaveBalanceReportCsv({
      year: reportYear,
      ...(typeFilter !== "ALL" ? { leaveTypeId: typeFilter } : {}),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    const blob = new Blob([res.data.csv], { type: res.data.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Leave balance report for ${reportYear} exported (${res.data.filename}).`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Scale size={14} className="text-pink-500" /> Balance report
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
            One row per leave type × member for the year — opening balance, allocated, taken, expired and
            closing — straight from the append-only leave ledger. Members with no ledger entries for any
            type are left out (the honest zero).
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            onClick={() => setReportYear((y) => y - 1)}
            aria-label={`Previous year (${reportYear - 1})`}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-foreground tabular-nums min-w-[3.5rem] text-center">
            {reportYear}
          </span>
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm"
            onClick={() => setReportYear((y) => y + 1)}
            aria-label={`Next year (${reportYear + 1})`}
          >
            <ChevronRight size={14} />
          </button>
          {reportYear !== year && (
            <button
              type="button"
              className="f-btn f-btn-ghost f-btn-sm"
              onClick={() => setReportYear(year)}
            >
              This year
            </button>
          )}
          <button
            type="button"
            className="f-btn f-btn-outline f-btn-sm"
            onClick={exportCsv}
            disabled={busy || !loaded}
            data-testid="balance-report-csv"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} CSV
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="f-input max-w-xs"
          placeholder="Search member, employee no or type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="balance-report-search"
        />
        <select
          className="f-input max-w-[12rem]"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by leave type"
        >
          <option value="ALL">All leave types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {typeNameById.get(t.id) ?? t.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {filtered.length} row{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {!loaded ? (
        <div className="text-sm text-muted-foreground">Loading balances…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <CalendarDays className="mx-auto mb-2 h-5 w-5 opacity-40" />
          No leave ledger entries for {reportYear}
          {typeFilter !== "ALL" ? " and this leave type" : ""}. Balances materialize when members first
          request leave or the allocation job runs.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Leave type</th>
                <th className="px-3 py-2 font-medium">Employee no</th>
                <th className="px-3 py-2 font-medium">Employee</th>
                <th className="px-3 py-2 font-medium text-right">Opening</th>
                <th className="px-3 py-2 font-medium text-right">Allocated</th>
                <th className="px-3 py-2 font-medium text-right">Taken</th>
                <th className="px-3 py-2 font-medium text-right">Expired</th>
                <th className="px-3 py-2 font-medium text-right">Closing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => (
                <tr key={`${r.leaveTypeId}-${r.userId}`} data-testid="balance-report-row">
                  <td className="px-3 py-2">{r.leaveTypeName}</td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.employeeNumber ?? "—"}</td>
                  <td className="px-3 py-2">{r.userName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDays(r.opening)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDays(r.allocated)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDays(r.taken)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", r.expired > 0 && "text-amber-600 dark:text-amber-400")}>
                    {fmtDays(r.expired)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtDays(r.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
