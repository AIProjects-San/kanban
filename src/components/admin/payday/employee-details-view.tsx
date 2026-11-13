"use client";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the Employee Details (ED) view: pending
// joiners/leavers for a month (the never-notify-twice listing), the filed
// history with the myIR lifecycle, and file generation/download.
//
// IRD's use-case order: the ED file goes FIRST, then the EI that includes
// the employee (an EI line for a brand-new employee can be rejected
// without their employee details on record).
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, Download, FilePlus2, Loader2, ShieldCheck, Upload, UserMinus, UserPlus,
} from "lucide-react";
import {
  downloadEmployeeDetailsFile,
  generateEmployeeDetailsAction,
  markEmployeeDetailsAcceptedAction,
  markEmployeeDetailsFiledAction,
} from "@/server-actions/payday-filing";
import type { EmployeeDetailsViewT, PayrollFilingSettingsT } from "@/lib/ird/filing-types";
import { downloadBlob } from "@/lib/shared/format";
import { FILING_STATUS_BADGE } from "@/lib/shared/config";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function EmployeeDetailsFilingView({
  view,
  settings,
}: {
  view: EmployeeDetailsViewT;
  settings: PayrollFilingSettingsT | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(view.pending.map((p) => p.userId)));

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const switchPeriod = (periodKey: string) => {
    router.push(`/admin/payroll/employee-details?period=${periodKey}`);
  };

  const generate = async () => {
    if (selected.size === 0) {
      toast.error("Select at least one employee to notify.");
      return;
    }
    setBusy(true);
    const res = await generateEmployeeDetailsAction({ employeeIds: [...selected] });
    setBusy(false);
    if (!res.ok) { toast.error(res.error, { duration: 12_000 }); return; }
    toast.success(`Employee Details file generated — ${res.data.employeeLineCount} line(s). Upload it to myIR before the employee's first (or last) Employment Information file.`);
    router.refresh();
  };

  const download = async (id: string) => {
    setBusy(true);
    const res = await downloadEmployeeDetailsFile({ id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    downloadBlob(res.data.csv, res.data.filename, res.data.mime);
    toast.success(`${res.data.filename} downloaded.`);
  };

  const markFiled = async (id: string) => {
    setBusy(true);
    const res = await markEmployeeDetailsFiledAction({ id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Marked as uploaded to myIR.");
    router.refresh();
  };

  const markAccepted = async (id: string) => {
    setBusy(true);
    const res = await markEmployeeDetailsAcceptedAction({ id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Marked accepted.");
    router.refresh();
  };

  // Month picker options: the seeded employment dates span 2023 → now.
  const monthOptions: string[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    monthOptions.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  return (
    <div className="space-y-4" data-testid="employee-details-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Employee Details (ED) filings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            IRD needs new and departing employee details by the next Employment Information due date — file the ED
            before the EI that includes them.
          </p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-muted-foreground">Employment month</span>
          <select
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            value={view.periodKey}
            onChange={(e) => switchPeriod(e.target.value)}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>

      {!settings && (
        <div className="rounded-lg border border-amber-400 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            The employer filing profile is not configured.{" "}
            <Link href="/admin/payroll/settings" className="font-medium underline underline-offset-2">Configure it</Link>{" "}
            before generating any IRD file.
          </div>
        </div>
      )}

      {/* Pending */}
      <div className="rounded-lg border border-border" data-testid="pending-ed-list">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <UserPlus size={14} className="text-violet-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Pending notifications — {view.periodKey}
          </div>
        </div>
        <div className="divide-y divide-border">
          {view.pending.map((p) => (
            <label key={p.userId} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(p.userId)}
                onChange={() => toggle(p.userId)}
                data-testid={`ed-select-${p.userId}`}
              />
              {p.kind === "NEW"
                ? <UserPlus size={14} className="text-emerald-600" />
                : <UserMinus size={14} className="text-orange-500" />}
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.reason}</span>
              <span className="ml-auto text-[0.625rem] font-semibold px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-600">{p.kind}</span>
            </label>
          ))}
          {view.pending.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No joiners or leavers in {view.periodKey} awaiting an IRD notification.
            </div>
          )}
        </div>
        {view.pending.length > 0 && (
          <div className="px-4 py-3 border-t border-border">
            <button
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={busy || !settings || selected.size === 0}
              onClick={() => void generate()}
              data-testid="generate-ed-btn"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <FilePlus2 size={14} />}
              Generate ED file ({selected.size})
            </button>
          </div>
        )}
      </div>

      {/* Filed history */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Notification history (each employee notified at most once per event)
          </div>
        </div>
        <div className="divide-y divide-border">
          {view.filed.map((f) => (
            <div key={f.id} className="px-4 py-2.5 flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">{f.employeeName}</span>
              <span className={`text-[0.625rem] font-semibold px-1.5 py-0.5 rounded ${FILING_STATUS_BADGE[f.status] ?? FILING_STATUS_BADGE.DRAFT}`}>{f.status}</span>
              <span className={`text-[0.625rem] font-semibold px-1.5 py-0.5 rounded ${f.kind === "NEW" ? "bg-emerald-500/10 text-emerald-600" : "bg-orange-500/10 text-orange-600"}`}>{f.kind}</span>
              <span className="text-xs text-muted-foreground font-mono">{f.employeeIrd}</span>
              <span className="text-xs text-muted-foreground">
                generated {day(f.generatedAt)}{f.filedAt ? ` · uploaded ${day(f.filedAt)}` : ""}{f.acceptedAt ? ` · accepted ${day(f.acceptedAt)}` : ""}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  disabled={busy}
                  onClick={() => void download(f.id)}
                >
                  <Download size={12} /> ED file
                </button>
                {f.status === "GENERATED" && (
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    disabled={busy}
                    onClick={() => void markFiled(f.id)}
                  >
                    <Upload size={12} /> Mark uploaded
                  </button>
                )}
                {f.status === "FILED" && (
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-500/20"
                    disabled={busy}
                    onClick={() => void markAccepted(f.id)}
                  >
                    <ShieldCheck size={12} /> Mark accepted
                  </button>
                )}
              </span>
            </div>
          ))}
          {view.filed.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No Employee Details notifications yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
