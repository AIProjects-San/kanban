"use client";

// Recruitment R7 — the Payroll view (docs/RECRUITMENT_MODULE_PLAN.md §5).
// ADMIN + HR only (payroll:manage gates the nav leaf AND every action):
//   • Runs — one per month, OPEN (editable payslips) → LOCKED (paid,
//     immutable). Creating a run snapshots every active salary structure.
//   • Payslips — per-employee monthly lines (earnings/deductions, pro-rated
//     LOP) editable while OPEN; the slip number + YTD net ride along.
//   • Structures — per-employee annual salary components (÷12 for the
//     monthly gross), copied from the signed offer or entered manually.

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Landmark, Loader2, Lock, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { PayrollRunT, PayslipT, SalaryStructureT } from "@/lib/types";
import {
  createPayrollRun,
  getPayrollData,
  getPayrollRun,
  lockPayrollRun,
} from "@/server-actions/payroll";
import { currentPeriod } from "@/lib/payroll-math";
import { computeOffer, formatMoney } from "@/lib/offer-math";
import { StructureModal } from "../ui/structure-modal";
import { PayslipModal } from "../ui/payslip-modal";
import { getDirectory } from "@/server-actions/hr-directory";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function PayrollView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const [structures, setStructures] = useState<SalaryStructureT[]>([]);
  const [runs, setRuns] = useState<PayrollRunT[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [payslips, setPayslips] = useState<PayslipT[]>([]);
  const [payslipsRun, setPayslipsRun] = useState<PayrollRunT | null>(null);
  const [openPayslip, setOpenPayslip] = useState<PayslipT | null>(null);
  const [structureModalOpen, setStructureModalOpen] = useState(false);
  const [editStructure, setEditStructure] = useState<SalaryStructureT | null>(null);
  const [newPeriod, setNewPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [lockConfirmId, setLockConfirmId] = useState<string | null>(null);
  // The employee picker lists every account (not just those with structures).
  const [employees, setEmployees] = useState<{ userId: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const res = await getPayrollData();
    if (res.ok) {
      setStructures(res.data.structures);
      setRuns(res.data.runs);
      // Keep a valid selection across reloads (default: newest run).
      setSelectedRunId((prev) => {
        const still = prev ? res.data.runs.find((r) => r.id === prev) : null;
        return still ? prev : res.data.runs[0]?.id ?? null;
      });
    } else {
      toast.error(res.error);
    }
    const dir = await getDirectory();
    if (dir.ok) setEmployees(dir.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const loadPayslips = useCallback(async (runId: string) => {
    const res = await getPayrollRun(runId);
    if (res.ok) {
      setPayslips(res.data.payslips);
      setPayslipsRun(res.data.run);
    } else {
      toast.error(res.error);
      setPayslips([]);
      setPayslipsRun(null);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (selectedRunId) void loadPayslips(selectedRunId); }, [selectedRunId, loadPayslips]);

  const activeStructureCount = structures.filter((s) => s.isActive).length;

  const createRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPeriod) { toast.error("Pick a month."); return; }
    setBusy(true);
    const res = await createPayrollRun({ period: newPeriod });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Run for ${newPeriod} created — ${res.data.payslipCount} payslips from the active structures.`);
    setSelectedRunId(null);
    await load();
    // Select the fresh run (the newest one for that period).
    const runsRes = await getPayrollData();
    if (runsRes.ok) {
      const fresh = runsRes.data.runs.find((r) => r.period === newPeriod);
      if (fresh) setSelectedRunId(fresh.id);
    }
  };

  const lockRun = async (runId: string) => {
    setBusy(true);
    const res = await lockPayrollRun({ runId });
    setBusy(false);
    setLockConfirmId(null);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Run locked — the period is paid and immutable.");
    await load();
    if (selectedRunId === runId) await loadPayslips(runId);
  };

  return (
    <div className="p-6 space-y-5" data-testid="payroll-view">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Landmark size={20} /> Payroll
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {runs.length} run{runs.length === 1 ? "" : "s"} · {activeStructureCount} active structure{activeStructureCount === 1 ? "" : "s"} · signed in as {currentUser.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="f-btn f-btn-ghost" onClick={() => { setEditStructure(null); setStructureModalOpen(true); }} data-testid="new-structure-btn">
            <Plus size={15} /> Salary structure
          </button>
        </div>
      </div>

      {/* New run */}
      <form onSubmit={createRun} className="rounded-lg border border-border p-4 flex flex-wrap items-end gap-3" data-testid="new-run-form">
        <div className="grow min-w-[180px]">
          <label htmlFor="payroll-period" className="block text-xs font-medium text-foreground mb-1.5">New monthly run</label>
          <input
            id="payroll-period"
            type="month"
            className="f-input"
            value={newPeriod}
            onChange={(e) => setNewPeriod(e.target.value)}
            data-testid="new-run-period"
          />
        </div>
        <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="create-run-btn">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />} Create run
        </button>
        <div className="text-xs text-muted-foreground basis-full sm:basis-auto">
          Snapshots every active structure into payslips (monthly = annual ÷ 12).
        </div>
      </form>

      {/* Runs */}
      <div className="rounded-lg border border-border" data-testid="payroll-runs">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <CalendarPlus size={14} className="text-sky-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Runs</div>
        </div>
        <div className="divide-y divide-border">
          {runs.map((r) => (
            <div key={r.id} className={cn("px-4 py-2.5 flex items-center gap-3 flex-wrap transition-colors", selectedRunId === r.id ? "bg-muted/60" : "hover:bg-muted/40")} data-testid={`run-row-${r.period}`}>
              <button
                className="text-left min-w-0 grow"
                onClick={() => setSelectedRunId(r.id)}
                data-testid={`run-select-${r.period}`}
              >
                <span className="text-sm font-medium">{monthLabel(r.period)}</span>
                <span className="block text-xs text-muted-foreground">
                  {r.payslipCount} payslip{r.payslipCount === 1 ? "" : "s"} · gross {money(r.totalGross)} · net {money(r.totalNet)}
                  {r.lockedBy ? ` · locked by ${r.lockedBy}` : ""}
                </span>
              </button>
              <span className={cn(
                "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                r.status === "OPEN" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600",
              )}>
                {r.status}
              </span>
              {r.status === "OPEN" && (
                lockConfirmId === r.id ? (
                  <span className="flex items-center gap-1.5 no-print">
                    <span className="text-xs text-muted-foreground">Mark paid & lock?</span>
                    <button className="f-btn f-btn-ghost text-xs" onClick={() => setLockConfirmId(null)} type="button">Cancel</button>
                    <button className="f-btn f-btn-primary text-xs" disabled={busy} onClick={() => void lockRun(r.id)} type="button" data-testid={`lock-confirm-${r.period}`}>
                      <Lock size={13} /> Lock {r.period}
                    </button>
                  </span>
                ) : (
                  <button className="f-btn f-btn-ghost text-xs no-print" onClick={() => setLockConfirmId(r.id)} type="button" data-testid={`lock-run-${r.period}`}>
                    <Lock size={13} /> Lock
                  </button>
                )
              )}
            </div>
          ))}
          {loaded && runs.length === 0 && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No runs yet — create one above once salary structures exist.
            </div>
          )}
        </div>
      </div>

      {/* Selected run payslips */}
      {payslipsRun && (
        <div className="rounded-lg border border-border" data-testid="payslips-panel">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Wallet size={14} className="text-emerald-600" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {monthLabel(payslipsRun.period)} payslips
            </div>
            <span className={cn(
              "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded",
              payslipsRun.status === "OPEN" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600",
            )}>
              {payslipsRun.status}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              net total {money(payslipsRun.totalNet)}
            </span>
          </div>
          <div className="divide-y divide-border">
            {payslips.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenPayslip(p)}
                className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
                data-testid="payslip-row"
              >
                <span className="text-xs font-mono text-muted-foreground shrink-0">{p.slipNo}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.userName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    gross {money(p.gross)} · deductions {money(p.gross - p.net)}
                    {p.lopDays > 0 ? ` · LOP ${p.lopDays}d` : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">YTD {money(p.ytdNet)}</span>
                <span className="font-semibold tabular-nums text-primary shrink-0">{money(p.net)}</span>
              </button>
            ))}
            {payslips.length === 0 && (
              <div className="text-sm text-muted-foreground px-4 py-6 text-center">No payslips in this run.</div>
            )}
          </div>
        </div>
      )}

      {/* Structures */}
      <div className="rounded-lg border border-border" data-testid="structures-panel">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Landmark size={14} className="text-purple-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Salary structures</div>
          <span className="text-xs text-muted-foreground ml-auto">{structures.length} total</span>
        </div>
        <div className="divide-y divide-border">
          {structures.map((s) => {
            const annual = computeOffer(s.components);
            return (
              <button
                key={s.id}
                onClick={() => { setEditStructure(s); setStructureModalOpen(true); }}
                className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
                data-testid="structure-row"
              >
                <span className={cn(
                  "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                  s.isActive ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground",
                )}>
                  {s.isActive ? "ACTIVE" : "HISTORY"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {s.userName}
                    {s.jobTitle ? ` · ${s.jobTitle}` : ""}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.components.length} components · effective {new Date(s.effectiveFrom).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    {s.source === "OFFER" ? " · from signed offer" : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">CTC {formatMoney(annual.ctc)}</span>
                <span className="font-semibold tabular-nums text-primary shrink-0">{money(Math.round((annual.earnings / 12) * 100) / 100)}/mo</span>
              </button>
            );
          })}
          {loaded && structures.length === 0 && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No salary structures yet — create one, or copy it from a signed offer.
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <StructureModal
        open={structureModalOpen}
        onClose={() => setStructureModalOpen(false)}
        onChanged={load}
        edit={editStructure}
        employees={employees}
      />
      <PayslipModal
        payslip={openPayslip}
        onClose={() => { setOpenPayslip(null); if (selectedRunId) void loadPayslips(selectedRunId); void load(); }}
        onChanged={() => { if (selectedRunId) void loadPayslips(selectedRunId); void load(); }}
      />
    </div>
  );
}
