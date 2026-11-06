"use client";

// Persona-audit P0-1 (D-02) — the payslip self-service view. Every signed-in
// user sees their OWN payslips from LOCKED runs only ("published" semantics —
// an OPEN run is still an HR-editable draft and never appears here). Rows
// open the shared PayslipModal, which renders LOCKED slips read-only with a
// print/save-PDF affordance. The full Payroll console (structures, runs,
// editing, locking) stays payroll:manage — this view has no management
// surface at all.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, Wallet } from "lucide-react";
import { toast } from "sonner";
import type { PayslipT } from "@/lib/types";
import { getMyPayslips } from "@/server-actions/payroll";
import { PayslipModal } from "../ui/payslip-modal";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function MyPayslipsView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const [slips, setSlips] = useState<PayslipT[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<PayslipT | null>(null);

  const load = useCallback(async () => {
    const res = await getMyPayslips();
    if (res.ok) {
      setSlips(res.data);
    } else {
      toast.error(res.error);
      setSlips([]);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const latest = slips[0] ?? null;
  const ytdThisYear = latest
    ? slips
        .filter((s) => s.runPeriod.slice(0, 4) === latest.runPeriod.slice(0, 4))
        .reduce((sum, s) => sum + s.net, 0)
    : 0;

  return (
    <div className="p-6 space-y-5" data-testid="my-payslips-view">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Wallet size={20} /> My Payslips
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {slips.length > 0
              ? `${slips.length} payslip${slips.length === 1 ? "" : "s"} · net paid this year ${money(Math.round(ytdThisYear * 100) / 100)} · ${currentUser.name}`
              : `Payslips appear here once a month is finalized (locked) · ${currentUser.name}`}
          </p>
        </div>
      </div>

      {/* Summary card — the basic employee question: what did I get paid? */}
      {latest && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-2" data-testid="my-payslips-latest">
          <div>
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Latest pay</div>
            <div className="text-lg font-bold tabular-nums text-primary">{money(latest.net)}</div>
            <div className="text-xs text-muted-foreground">{monthLabel(latest.runPeriod)} · {latest.slipNo}</div>
          </div>
          <div>
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Gross</div>
            <div className="text-sm font-semibold tabular-nums">{money(latest.gross)}</div>
          </div>
          <div>
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Deductions</div>
            <div className="text-sm font-semibold tabular-nums text-destructive">{money(Math.round((latest.gross - latest.net) * 100) / 100)}</div>
          </div>
          <div>
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Net YTD {latest.runPeriod.slice(0, 4)}</div>
            <div className="text-sm font-semibold tabular-nums">{money(latest.ytdNet)}</div>
          </div>
          <button className="f-btn f-btn-secondary ml-auto" onClick={() => setOpen(latest)} data-testid="my-payslips-latest-open">
            View payslip
          </button>
        </div>
      )}

      {/* Payslip list */}
      <div className="rounded-lg border border-border" data-testid="my-payslips-list">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Wallet size={14} className="text-emerald-600" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Payslip history</div>
          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
            <Lock size={11} /> finalized months only
          </span>
        </div>
        <div className="divide-y divide-border">
          {slips.map((p) => (
            <button
              key={p.id}
              onClick={() => setOpen(p)}
              className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
              data-testid="my-payslip-row"
              data-period={p.runPeriod}
            >
              <span className="text-xs font-mono text-muted-foreground shrink-0">{p.slipNo}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{monthLabel(p.runPeriod)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  gross {money(p.gross)} · deductions {money(Math.round((p.gross - p.net) * 100) / 100)}
                  {p.lopDays > 0 ? ` · LOP ${p.lopDays}d (${p.lopSource === "MANUAL" ? "manual" : "auto"})` : ""}
                </span>
              </span>
              <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">YTD {money(p.ytdNet)}</span>
              <span className="font-semibold tabular-nums text-primary shrink-0">{money(p.net)}</span>
            </button>
          ))}
          {loaded && slips.length === 0 && (
            <div className="px-4 py-8 text-center" data-testid="my-payslips-empty">
              <p className="text-sm text-muted-foreground">No payslips yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Your payslips appear here once your HR or admin finalizes (locks) the monthly payroll run.
                Draft months are never shown.
              </p>
            </div>
          )}
          {!loaded && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading your payslips…
            </div>
          )}
        </div>
      </div>

      {/* Read-only detail — PayslipModal renders LOCKED slips immutable + print */}
      <PayslipModal payslip={open} onClose={() => setOpen(null)} onChanged={load} />
    </div>
  );
}
