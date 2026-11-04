"use client";

// Persona-audit P0-1 (D-02) — dashboard shortcut card for payslip
// self-service. Self-fetching on mount (no change to the dashboard's data
// flow) and renders NOTHING until the signed-in user has at least one
// finalized payslip — users without payroll history see no empty card.

import { useEffect, useState } from "react";
import { ArrowRight, Wallet } from "lucide-react";
import type { PayslipT } from "@/lib/types";
import { getMyPayslips } from "@/server-actions/payroll";
import { useApp } from "@/store/app-store";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function MyPayslipsCard() {
  const setView = useApp((s) => s.setView);
  const [latest, setLatest] = useState<PayslipT | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getMyPayslips();
      if (!cancelled && res.ok && res.data.length > 0) setLatest(res.data[0]);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!latest) return null;

  return (
    <div className="f-card p-5" data-testid="my-payslips-card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Latest payslip</h2>
          <p className="text-[0.625rem] text-muted-foreground">{monthLabel(latest.runPeriod)} · finalized</p>
        </div>
        <Wallet size={14} className="text-emerald-600" />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-lg font-bold tabular-nums text-primary">{money(latest.net)}</div>
          <div className="text-[0.625rem] text-muted-foreground">net · gross {money(latest.gross)}</div>
        </div>
        <button
          onClick={() => setView("my-payslips")}
          className="text-xs text-primary hover:underline flex items-center gap-1"
          data-testid="my-payslips-card-link"
        >
          My Payslips <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}
